import { Database } from "@/supabase/types"
import { ChatSettings } from "@/types"
import { createClient } from "@supabase/supabase-js"
import { OpenAIStream, StreamingTextResponse } from "ai"
import { ServerRuntime } from "next"
import OpenAI from "openai"
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions.mjs"

export const runtime = "edge"

export async function POST(request: Request) {
  const json = await request.json()
  const { chatSettings, messages, customModelId } = json as {
    chatSettings: ChatSettings
    messages: any[]
    customModelId: string
  }

  // Send an initial response to the client
  const initialResponse = new Response(JSON.stringify({ message: "Request received. Processing..." }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  })
  await initialResponse.send()

  try {
    const supabaseAdmin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: customModel, error } = await supabaseAdmin
      .from("models")
      .select("*")
      .eq("id", customModelId)
      .single()

    if (!customModel) {
      throw new Error(error.message)
    }

    const custom = new OpenAI({
      apiKey: customModel.api_key || "",
      baseURL: customModel.base_url
    })

    if (customModel.base_url.includes("https://skoop.app.n8n.cloud")) {
      // Process response for custom models hosted on skoop.app.n8n.cloud
      const response = await custom.chat.completions.create({
        model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
        messages: messages as ChatCompletionCreateParamsBase["messages"],
        temperature: chatSettings.temperature,
        stream: false
      })

      const assistantMessage = response.choices[0].message.content

      // Send the complete response to the client
      await fetch(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain'
        },
        body: assistantMessage
      })
    } else {
      // Process response for other custom models with streaming
      const response = await custom.chat.completions.create({
        model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
        messages: messages as ChatCompletionCreateParamsBase["messages"],
        temperature: chatSettings.temperature,
        stream: true
      })

      const stream = OpenAIStream(response)

      // Send the streaming response to the client
      await fetch(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain'
        },
        body: stream
      })
    }
  } catch (error: any) {
    let errorMessage = error.message || "An unexpected error occurred"
    const errorCode = error.status || 500

    if (errorMessage.toLowerCase().includes("api key not found")) {
      errorMessage =
        "Custom API Key not found. Please set it in your profile settings."
    } else if (errorMessage.toLowerCase().includes("incorrect api key")) {
      errorMessage =
        "Custom API Key is incorrect. Please fix it in your profile settings."
    }

    await fetch(request.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: errorMessage })
    })
  }
}
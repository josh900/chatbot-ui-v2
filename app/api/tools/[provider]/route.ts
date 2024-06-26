import { ChatClientProxy } from "@/lib/chat/client/ChatClientProxy"
import { OPENAI_LLM_LIST } from "@/lib/models/llm/openai-llm-list"
import { openapiToFunctions } from "@/lib/openapi-conversion"
import { platformToolFunction } from "@/lib/platformTools/utils/platformToolsUtils"
import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { Tables } from "@/supabase/types"
import { ChatSettings, LLMID } from "@/types"
import OpenAI from "openai"

export async function POST(request: Request) {
  const url = new URL(request.url)
  const provider = url.pathname.split("/").pop()

  const json = await request.json()
  const { chatSettings, messages, customModelId, selectedTools } = json as {
    chatSettings: ChatSettings
    messages: any[]
    customModelId?: string
    selectedTools: Tables<"tools">[]
  }

  try {
    const profile = await getServerProfile()

    checkApiKey(profile.openai_api_key, "OpenAI")

    const openai = new OpenAI({
      apiKey: profile.openai_api_key || "",
      organization: profile.openai_organization_id
    })

    let allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
    let allRouteMaps = {}
    let schemaDetails = []

    for (const selectedTool of selectedTools) {
      try {
        const convertedSchema = await openapiToFunctions(
          JSON.parse(selectedTool.schema as string)
        )
        const tools = convertedSchema.functions || []
        allTools = allTools.concat(tools)

        const routeMap = convertedSchema.routes.reduce(
          (map: Record<string, string>, route) => {
            map[route.path.replace(/{(\w+)}/g, ":$1")] = route.operationId
            return map
          },
          {}
        )

        allRouteMaps = { ...allRouteMaps, ...routeMap }

        schemaDetails.push({
          title: convertedSchema.info.title,
          description: convertedSchema.info.description,
          url: convertedSchema.info.server,
          headers: selectedTool.custom_headers,
          routeMap,
          requestInBody: convertedSchema.routes[0].requestInBody
        })
      } catch (error: any) {
        console.error("Error converting schema", error)
      }
    }

    let toolModel = chatSettings.model
    let isOpenAIModel = true

    const modelDetails = OPENAI_LLM_LIST.find(
      (model: any) => model.modelId === chatSettings.model
    )
    if (!modelDetails) {
      toolModel =
        (process.env.OPENAI_DEFAULT_TOOL_MODEL as LLMID) || "gpt-3.5-turbo"
      isOpenAIModel = false
    }

    const firstResponse = await openai.chat.completions.create({
      model: toolModel,
      messages,
      tools: allTools.length > 0 ? allTools : undefined
    })

    const message = firstResponse.choices[0].message
    messages.push(message)
    const toolCalls = message.tool_calls || []

    if (toolCalls.length === 0) {
      return new Response(message.content, {
        headers: {
          "Content-Type": "application/json"
        }
      })
    }

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name
        const argumentsString = toolCall.function.arguments.trim()
        const parsedArgs = JSON.parse(argumentsString)

        // Find the schema detail that contains the function name
        const schemaDetail = schemaDetails.find(detail =>
          Object.values(detail.routeMap).includes(functionName)
        )

        if (!schemaDetail) {
          throw new Error(`Function ${functionName} not found in any schema`)
        }

        // Reroute to local executor for local tools
        if (schemaDetail.url === "local://executor") {
          const toolFunction = platformToolFunction(functionName)
          if (!toolFunction) {
            throw new Error(`Function ${functionName} not found`)
          }

          const data = await toolFunction(parsedArgs)

          messages.push({
            tool_call_id: toolCall.id,
            role: isOpenAIModel ? "tool" : "system",
            name: functionName,
            content: JSON.stringify(data)
          })

          continue
        }

        const pathTemplate = Object.keys(schemaDetail.routeMap).find(
          key => schemaDetail.routeMap[key] === functionName
        )

        if (!pathTemplate) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        const path = pathTemplate.replace(/:(\w+)/g, (_, paramName) => {
          const value = parsedArgs.parameters[paramName]
          if (!value) {
            throw new Error(
              `Parameter ${paramName} not found for function ${functionName}`
            )
          }
          return encodeURIComponent(value)
        })

        if (!path) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        // Determine if the request should be in the body or as a query
        const isRequestInBody = schemaDetail.requestInBody
        let data = {}

        if (isRequestInBody) {
          // If the type is set to body
          let headers = {
            "Content-Type": "application/json"
          }

          // Check if custom headers are set
          const customHeaders = schemaDetail.headers // Moved this line up to the loop
          // Check if custom headers are set and are of type string
          if (customHeaders && typeof customHeaders === "string") {
            let parsedCustomHeaders = JSON.parse(customHeaders) as Record<
              string,
              string
            >

            headers = {
              ...headers,
              ...parsedCustomHeaders
            }
          }

          const fullUrl = schemaDetail.url + path

          const bodyContent = parsedArgs.requestBody || parsedArgs

          const requestInit = {
            method: "POST",
            headers,
            body: JSON.stringify(bodyContent) // Use the extracted requestBody or the entire parsedArgs
          }

          const response = await fetch(fullUrl, requestInit)

          if (!response.ok) {
            data = {
              error: response.statusText
            }
          } else {
            data = await response.json()
          }
        } else {
          // If the type is set to query
          const queryParams = new URLSearchParams(
            parsedArgs.parameters
          ).toString()
          const fullUrl =
            schemaDetail.url + path + (queryParams ? "?" + queryParams : "")

          let headers = {}

          // Check if custom headers are set
          const customHeaders = schemaDetail.headers
          if (customHeaders && typeof customHeaders === "string") {
            headers = JSON.parse(customHeaders)
          }

          const response = await fetch(fullUrl, {
            method: "GET",
            headers: headers
          })

          if (!response.ok) {
            data = {
              error: response.statusText
            }
          } else {
            data = await response.json()
          }
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: isOpenAIModel ? "tool" : "system",
          name: functionName,
          content: JSON.stringify(data)
        })
      }
    }

    // Second response with the tool call results
    const chatClientProxy = new ChatClientProxy(provider || ``)

    try {
      await chatClientProxy.initialize(customModelId)
      return await chatClientProxy.createChatCompletion(chatSettings, messages)
    } catch (error: any) {
      return new Response(JSON.stringify({ message: error.message }), {
        status: error.status || 500
      })
    }
  } catch (error: any) {
    console.error(error)
    const errorMessage = error.error?.message || "An unexpected error occurred"
    const errorCode = error.status || 500
    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode
    })
  }
}

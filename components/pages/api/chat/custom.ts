import { NextApiRequest, NextApiResponse } from "next"
import { CustomChatClient } from "@/lib/chat/client/impl/CustomChatClient"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === "POST") {
    const { chatSettings, messages, customModelId } = req.body

    try {
      const chatClient = new CustomChatClient()
      await chatClient.initialize(customModelId)

      const response = await chatClient.generateChatCompletion(
        chatSettings,
        messages
      )

      res.status(200).json(response)
    } catch (error: any) {
      res.status(500).json({ message: error.message })
    }
  } else {
    res.status(405).json({ message: "Method not allowed" })
  }
}
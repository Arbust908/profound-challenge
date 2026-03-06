import { createAPIFileRoute } from '@tanstack/react-start/api'
import { streamText } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { tavily } from '@ai-sdk/tavily'
import { supabaseServer } from '~/lib/supabase-server'

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
})

export const APIRoute = createAPIFileRoute('/api/summarize')({
  POST: async ({ request }) => {
    const { sessionId } = await request.json() as { sessionId: string }

    // 1. Get session from DB
    const { data: session, error: sessionError } = await supabaseServer
      .from('sessions')
      .select('url')
      .eq('id', sessionId)
      .single()

    if (sessionError || !session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. Update status to streaming
    await supabaseServer
      .from('sessions')
      .update({ status: 'streaming' })
      .eq('id', sessionId)

    // 3. Stream summary — Tavily tool fetches and extracts the page content
    //    maxSteps: 3 keeps the agentic loop going:
    //      Step 1: model reads the prompt → calls webSearch tool
    //      Step 2: Tavily fetches the URL → returns clean text to model
    //      Step 3: model streams the summary ✓
    let pageTitle = ''

    const result = streamText({
      model: openrouter.chat('anthropic/claude-3.5-haiku'),
      system: `You are a concise summarization assistant.
When given a URL, use the webSearch tool to retrieve its content.
Then write a clear, well-structured markdown summary covering the main ideas,
key facts, and conclusions. Use headers and bullet points where appropriate.`,
      messages: [
        {
          role: 'user',
          content: `Please summarize this page: ${session.url}`,
        },
      ],
      tools: {
        webSearch: tavily({ apiKey: process.env.TAVILY_API_KEY! }),
      },
      maxSteps: 3,
      async onFinish({ text }) {
        // 4. Persist completed summary
        await supabaseServer
          .from('sessions')
          .update({ summary: text, status: 'done', title: pageTitle || null })
          .eq('id', sessionId)
      },
    })

    return result.toTextStreamResponse()
  },
})
// Fake OpenAI-completions provider for the e2e smoke run. Serves one
// streaming chat-completions endpoint that replies with a fixed sentence, so
// a launched ajent session completes a real turn with no external service.
// A prompt carrying toolPrompt is answered with one gated bash call instead,
// which the permission barrier turns into a dialog until the user answers it.
// The follow-up request carrying that tool result gets the sentence back.
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 8391)

const replyText = 'The smoke test reply.'

// toolPrompt marks the user prompt that asks for the gated tool call, and
// toolCall answers it: a mkdir the permission barrier holds for an answer.
const toolPrompt = 'smoke tool call'
const toolCall = {
  index: 0,
  id: 'call-smoke',
  type: 'function',
  function: {
    name: 'bash',
    arguments: JSON.stringify({ command: 'mkdir -p /tmp/swarm-e2e-dialog' }),
  },
}

const server = http.createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const id = 'chatcmpl-smoke'
    const model = 'fake-model'
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const chunk = (delta, finish_reason = null) => ({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })
    const messages = JSON.parse(body || '{}').messages ?? []
    // JSON.stringify reads a body as text, string or part list alike
    const asked = messages.some(
      (m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes(toolPrompt),
    )
    const answered = messages.some((m) => m.role === 'tool')
    send(chunk({ role: 'assistant' }))
    if (asked && !answered) {
      send(chunk({ tool_calls: [toolCall] }))
      send(chunk({}, 'tool_calls'))
    } else {
      // one word per chunk, so the swarm delta path exercises too
      for (const word of replyText.split(' ')) {
        send(chunk({ content: `${word} ` }))
      }
      send({
        ...chunk({}, 'stop'),
        usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
      })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake provider on http://127.0.0.1:${port}`)
})

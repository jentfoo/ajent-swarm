// Fake OpenAI-completions provider for the e2e smoke run. Serves one
// streaming chat-completions endpoint that replies with a fixed sentence, so
// a launched ajent session completes a real turn with no external service.
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 8391)

const replyText = 'The smoke test reply.'

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
    send({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })
    // one word per chunk, so the swarm delta path exercises too
    for (const word of replyText.split(' ')) {
      send({
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
      })
    }
    send({
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake provider on http://127.0.0.1:${port}`)
})

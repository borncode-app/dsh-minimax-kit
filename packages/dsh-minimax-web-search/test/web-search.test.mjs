import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAnswer,
  collectSources,
  MinimaxSearchError,
  MinimaxSearchProvider,
  QUOTA_PATTERN,
  searchPrompt,
} from '../index.js'

/** The provider's default options, as the plugin hands them over. */
function options(overrides = {}) {
  return {
    baseURL: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M3.1-Flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 3,
    maxContinuations: 4,
    apiKeyEnv: 'MINIMAX_API_KEY',
    creditBaseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
    ...overrides,
  }
}

/** A credentials service that answers one reference. */
function credentials(value) {
  return { resolve: async () => (value === undefined ? undefined : { value }) }
}

/** One search result block as MiniMax returns it. */
function resultBlock(items) {
  return { type: 'web_search_tool_result', tool_use_id: 'call_1', content: items }
}

test('the sources of a response are collected with their excerpts', () => {
  const payload = {
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: "I'll search for that." },
      resultBlock([
        { type: 'web_search_result', title: 'Bitcoin', url: 'https://example.com/a', page_age: 'Nov 14, 2026', content: 'Price is 64000.' },
        { type: 'web_search_result', title: 'BTC', url: 'https://example.com/b', content: 'Another excerpt.' },
      ]),
    ],
  }
  assert.deepEqual(collectSources(payload), [
    { url: 'https://example.com/a', title: 'Bitcoin', snippet: 'Price is 64000.', publishedAt: 'Nov 14, 2026' },
    { url: 'https://example.com/b', title: 'BTC', snippet: 'Another excerpt.' },
  ])
})

test('a repeated URL is kept once', () => {
  const payload = {
    content: [
      resultBlock([{ type: 'web_search_result', title: 'A', url: 'https://example.com/a', content: 'x' }]),
      resultBlock([{ type: 'web_search_result', title: 'A again', url: 'https://example.com/a', content: 'y' }]),
    ],
  }
  assert.equal(collectSources(payload).length, 1)
})

test('a result item without a URL is skipped', () => {
  const payload = {
    content: [
      resultBlock([
        { type: 'web_search_result', title: 'No URL', content: 'x' },
        { type: 'web_search_result', title: 'Fine', url: 'https://example.com/a', content: 'y' },
      ]),
    ],
  }
  assert.deepEqual(collectSources(payload).map(source => source.url), ['https://example.com/a'])
})

test('the last text block is the answer, not the lead-in', () => {
  const payload = {
    content: [
      { type: 'text', text: "I'll search for that." },
      resultBlock([{ type: 'web_search_result', url: 'https://example.com/a', content: 'x' }]),
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Bitcoin is around 64000.' },
    ],
  }
  assert.equal(collectAnswer(payload), 'Bitcoin is around 64000.')
})

test('a response without text has no answer', () => {
  assert.equal(collectAnswer({ content: [resultBlock([])] }), undefined)
})

test('the prompt asks for the search the query names', () => {
  assert.equal(searchPrompt('bitcoin price'), 'Perform a web search for the query: bitcoin price')
})

test('the plan quota refusal is recognized', () => {
  assert.ok(QUOTA_PATTERN.test('Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)'))
  assert.ok(QUOTA_PATTERN.test('insufficient credits'))
  assert.equal(QUOTA_PATTERN.test('rate limit reached, please retry'), false)
})

test('a search sends the native web_search tool to the Messages endpoint', async () => {
  const calls = []
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('sk-cp-test'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [
          resultBlock([{ type: 'web_search_result', title: 'A', url: 'https://example.com/a', content: 'excerpt' }]),
          { type: 'text', text: 'The answer.' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.search({ query: 'bitcoin price', maxResults: 5 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.minimax.io/anthropic/v1/messages')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
  assert.equal(body.messages[0].content[0].text, 'Perform a web search for the query: bitcoin price')
  // The model cannot disable thinking, so the request never says so.
  assert.equal(body.thinking, undefined)
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.com/a'])
  assert.equal(result.content, 'The answer.')
})

test('a pause_turn is continued until the model answers', async () => {
  const calls = []
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('sk-cp-test'),
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body))
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          stop_reason: 'pause_turn',
          content: [
            resultBlock([{ type: 'web_search_result', title: 'A', url: 'https://example.com/a', content: 'one' }]),
            { type: 'server_tool_use', id: 'call_1', name: 'web_search', input: { query: 'x' } },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [
          resultBlock([{ type: 'web_search_result', title: 'B', url: 'https://example.com/b', content: 'two' }]),
          { type: 'text', text: 'Done.' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.search({ query: 'bitcoin price' })
  assert.equal(calls.length, 2)
  // The second request carries the first response as an assistant message.
  assert.equal(calls[1].messages.length, 2)
  assert.equal(calls[1].messages[1].role, 'assistant')
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.com/a', 'https://example.com/b'])
})

test('the continuation budget bounds the rounds', async () => {
  let calls = 0
  const provider = new MinimaxSearchProvider(() => options({ maxContinuations: 2 }), {
    credentials: credentials('sk-cp-test'),
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({
        stop_reason: 'pause_turn',
        content: [resultBlock([{ type: 'web_search_result', url: `https://example.com/${calls}`, content: 'x' }])],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.search({ query: 'bitcoin price' })
  assert.equal(calls, 3)
  assert.equal(result.sources.length, 3)
})

test('a spent plan quota continues on credits with the grant', async () => {
  const calls = []
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('sk-cp-test'),
    tokens: { token: async () => 'mcode-token' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ error: { type: 'rate_limit_error', message: 'Token Plan usage limit reached (2056)' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [
          resultBlock([{ type: 'web_search_result', title: 'A', url: 'https://example.com/a', content: 'excerpt' }]),
          { type: 'text', text: 'The answer.' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.search({ query: 'bitcoin price' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://agent.minimax.io/mavis/api/v1/llm/v1/messages')
  assert.equal(calls[1].init.headers.authorization, 'Bearer mcode-token')
  assert.equal(result.sources.length, 1)
})

test('a response without search results is an error', async () => {
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('sk-cp-test'),
    fetchImpl: async () => new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I did not search.' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(
    () => provider.search({ query: 'bitcoin price' }),
    error => error instanceof MinimaxSearchError && error.code === 'MINIMAX_SEARCH_NO_RESULTS',
  )
})

test('a missing key is reported before any request', async () => {
  let called = false
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials(undefined),
    tokens: { token: async () => { throw new Error('no sign-in') } },
    fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }) },
  })
  await assert.rejects(
    () => provider.search({ query: 'bitcoin price' }),
    error => error instanceof MinimaxSearchError && error.code === 'MINIMAX_SEARCH_CREDENTIAL_MISSING',
  )
  assert.equal(called, false)
})

test('an HTTP failure names the endpoint the request used', async () => {
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('sk-cp-test'),
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'model not found' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  })
  await assert.rejects(
    () => provider.search({ query: 'bitcoin price' }),
    error => error instanceof MinimaxSearchError
      && error.code === 'MINIMAX_SEARCH_FAILED'
      && error.message.includes('model not found')
      && error.message.includes('https://api.minimax.io/anthropic/v1/messages'),
  )
})

test('the provider is available with a usable configuration', () => {
  const provider = new MinimaxSearchProvider(() => options(), { credentials: credentials('k') })
  assert.equal(provider.available(), true)
  assert.equal(provider.id, 'minimax-web-search')
})

test('an unusable configuration is not available', () => {
  const provider = new MinimaxSearchProvider(() => options({ maxUses: 0 }), { credentials: credentials('k') })
  assert.equal(provider.available(), false)
})

test('readiness follows the key, then the grant', async () => {
  const withKey = new MinimaxSearchProvider(() => options(), { credentials: credentials('k') })
  assert.equal(await withKey.ready('minimax-api'), true)

  const withoutKey = new MinimaxSearchProvider(() => options(), {
    credentials: credentials(undefined),
    tokens: { token: async () => 'mcode-token' },
  })
  assert.equal(await withoutKey.ready('minimax-api'), true)

  const withoutAny = new MinimaxSearchProvider(() => options(), {
    credentials: credentials(undefined),
    tokens: { token: async () => { throw new Error('no sign-in') } },
  })
  assert.equal(await withoutAny.ready('minimax-api'), false)
})

test('an aborted search reports cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  const provider = new MinimaxSearchProvider(() => options(), {
    credentials: credentials('k'),
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  await assert.rejects(
    () => provider.search({ query: 'bitcoin price' }, controller.signal),
    error => error instanceof MinimaxSearchError && error.code === 'MINIMAX_SEARCH_ABORTED',
  )
})

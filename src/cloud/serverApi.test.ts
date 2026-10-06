import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerApi, UnreachableError } from './serverApi'

function answer(body: string, contentType = 'application/json', status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } })),
  )
}

describe('finding the server', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports who is signed in when the server answers', async () => {
    answer('{"user":null}')
    await expect(createServerApi('/api').getUser()).resolves.toBeNull()
    answer('{"user":{"id":"u1","email":"ana@example.com"}}')
    await expect(createServerApi('/api').getUser()).resolves.toEqual({ id: 'u1', email: 'ana@example.com' })
  })

  it('treats a host without the server as no server', async () => {
    // Static hosting serves the app page for any path.
    answer('<!doctype html><html></html>', 'text/html')
    await expect(createServerApi('/api').getUser()).rejects.toThrow('not running')
    answer('{}')
    await expect(createServerApi('/api').getUser()).rejects.toThrow('not running')
    answer('Not found', 'text/plain', 404)
    await expect(createServerApi('/api').getUser()).rejects.toThrow()
  })

  it('reports a server that is still starting as unreachable', async () => {
    answer('', 'text/plain', 500) // the dev proxy, before the server listens
    await expect(createServerApi('/api').getUser()).rejects.toBeInstanceOf(UnreachableError)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(createServerApi('/api').getUser()).rejects.toBeInstanceOf(UnreachableError)
  })
})

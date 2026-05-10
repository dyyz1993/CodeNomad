import { request, type APIRequestContext } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:19899"
const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"
const TEST_USERNAME = "codenomad"

export interface ServerContext {
  api: APIRequestContext
  authedApi: APIRequestContext
}

export async function createServerContext(): Promise<ServerContext> {
  const api = await request.newContext({ baseURL: BASE_URL })

  const loginResponse = await api.post("/api/auth/login", {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })

  const cookies = loginResponse.headers()["set-cookie"]
  const cookieHeader = Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "")

  const authedApi = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      cookie: cookieHeader,
    },
  })

  return { api, authedApi }
}

export { BASE_URL, TEST_PASSWORD, TEST_USERNAME }

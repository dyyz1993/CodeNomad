import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Filesystem API", () => {
  let authCookie: string

  test.beforeAll(async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    authCookie = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]
  })

  test("Browse filesystem returns entries", async ({ request }) => {
    const response = await request.get("/api/filesystem", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body).toHaveProperty("entries")
    expect(Array.isArray(body.entries)).toBeTruthy()
  })

  test("Browse /tmp directory", async ({ request }) => {
    const response = await request.get("/api/filesystem?path=/tmp", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body).toHaveProperty("entries")
  })
})

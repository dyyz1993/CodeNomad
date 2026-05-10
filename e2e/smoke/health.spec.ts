import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Health endpoint", () => {
  test("GET /api/health requires authentication", async ({ request }) => {
    const unauthed = await request.get("/api/health")
    expect(unauthed.status()).toBe(401)
  })

  test("GET /api/health returns 200 with valid JSON when authenticated", async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    const cookieValue = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]

    const response = await request.get("/api/health", {
      headers: { cookie: cookieValue },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body).toHaveProperty("status", "ok")
    expect(body).toHaveProperty("timestamp")
  })

  test("GET / returns HTML", async ({ request }) => {
    const response = await request.get("/", {
      headers: { Accept: "text/html" },
    })
    expect(response.status()).toBeLessThan(400)
    const contentType = response.headers()["content-type"] ?? ""
    expect(contentType).toMatch(/html/)
  })
})

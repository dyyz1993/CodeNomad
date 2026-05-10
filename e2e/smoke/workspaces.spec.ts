import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Workspace API", () => {
  let authCookie: string

  test.beforeAll(async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    authCookie = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]
  })

  test("GET /api/workspaces returns empty array initially", async ({ request }) => {
    const response = await request.get("/api/workspaces", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(Array.isArray(body)).toBeTruthy()
  })

  test("GET /api/workspaces/:id returns 404 for non-existent", async ({ request }) => {
    const response = await request.get("/api/workspaces/nonexistent-id-12345", {
      headers: { cookie: authCookie },
    })
    expect(response.status()).toBe(404)
  })

  test("DELETE /api/workspaces/:id returns 404 for non-existent", async ({ request }) => {
    const response = await request.delete("/api/workspaces/nonexistent-id-12345", {
      headers: { cookie: authCookie },
    })
    expect(response.status()).toBe(404)
  })
})

import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Authentication API", () => {
  test("Unauthenticated GET /api/auth/status returns false", async ({ request }) => {
    const response = await request.get("/api/auth/status")
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.authenticated).toBe(false)
  })

  test("POST /api/auth/login with correct credentials succeeds", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.ok).toBe(true)
    const setCookie = response.headers()["set-cookie"]
    expect(setCookie).toBeTruthy()
  })

  test("POST /api/auth/login with wrong password returns 401", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: "wrongpassword" },
    })
    expect(response.status()).toBe(401)
  })

  test("POST /api/auth/login with missing fields returns error", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: {},
    })
    expect(response.ok()).toBeFalsy()
  })

  test("Authenticated status after login", async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    const cookieValue = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]

    const statusResponse = await request.get("/api/auth/status", {
      headers: { cookie: cookieValue },
    })
    expect(statusResponse.ok()).toBeTruthy()
    const body = await statusResponse.json()
    expect(body.authenticated).toBe(true)
  })

  test("POST /api/auth/logout returns ok", async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    const cookieValue = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]

    const logoutResponse = await request.post("/api/auth/logout", {
      headers: { cookie: cookieValue },
    })
    expect(logoutResponse.ok()).toBeTruthy()
    const body = await logoutResponse.json()
    expect(body.ok).toBe(true)
  })
})

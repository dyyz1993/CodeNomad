import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Settings & Meta API", () => {
  let authCookie: string

  test.beforeAll(async ({ request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { username: "codenomad", password: TEST_PASSWORD },
    })
    const cookies = loginResponse.headers()["set-cookie"] ?? ""
    authCookie = Array.isArray(cookies) ? cookies[0] : cookies.split(";")[0]
  })

  test("GET /api/meta returns server metadata", async ({ request }) => {
    const response = await request.get("/api/meta", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body).toHaveProperty("localUrl")
  })

  test("GET /api/storage/config returns config document", async ({ request }) => {
    const response = await request.get("/api/storage/config", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(typeof body).toBe("object")
  })

  test("GET /api/storage/state returns state document", async ({ request }) => {
    const response = await request.get("/api/storage/state", {
      headers: { cookie: authCookie },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(typeof body).toBe("object")
  })
})

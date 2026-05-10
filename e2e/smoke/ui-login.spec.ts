import { test, expect } from "@playwright/test"

const TEST_PASSWORD = process.env.E2E_PASSWORD ?? "e2etest"

test.describe("Login page UI", () => {
  test("Login page renders with form elements", async ({ page }) => {
    await page.goto("/login")
    const usernameInput = page.locator("#username")
    await expect(usernameInput).toBeVisible()
    const passwordInput = page.locator("#password")
    await expect(passwordInput).toBeVisible()
    const submitButton = page.locator("#submit")
    await expect(submitButton).toBeVisible()
  })

  test("Login with valid credentials redirects to main page", async ({ page }) => {
    await page.goto("/login")
    await page.locator("#username").fill("codenomad")
    await page.locator("#password").fill(TEST_PASSWORD)
    await page.locator("#submit").click()
    await page.waitForURL(/^(?!.*\/login)/, { timeout: 10_000 })
    expect(page.url()).not.toContain("/login")
  })

  test("Login with wrong password shows error", async ({ page }) => {
    await page.goto("/login")
    await page.locator("#username").fill("codenomad")
    await page.locator("#password").fill("wrongpassword")
    await page.locator("#submit").click()
    const errorEl = page.locator("#error")
    await expect(errorEl).toBeVisible({ timeout: 5_000 })
  })
})

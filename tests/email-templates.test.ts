import { describe, expect, it } from "vitest";
import { getMagicLinkEmail, wrapEmail } from "../src/email/templates";

describe("Email Templates", () => {
  describe("getMagicLinkEmail", () => {
    it("should generate magic link email with all required fields", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/auth/verify?token=abc123",
        email: "user@example.com",
      });

      expect(result.subject).toBe("Sign in to Stratum");
      expect(result.text).toContain("https://example.com/auth/verify?token=abc123");
      expect(result.html).toContain("https://example.com/auth/verify?token=abc123");
      expect(result.html).toContain("user@example.com");
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain("Sign in to Stratum");
    });

    it("should include plain text fallback", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=test",
        email: "test@example.com",
      });

      expect(result.text).toContain("Click the link below to sign in to Stratum");
      expect(result.text).toContain("https://example.com/verify?token=test");
      expect(result.text).toContain("15 minutes");
    });

    it("should escape HTML in magic link to prevent XSS", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com?token=<script>alert('xss')</script>",
        email: "user@example.com",
      });

      // Should not contain unescaped script tags
      expect(result.html).not.toContain("<script>alert('xss')</script>");
      // Should contain escaped version
      expect(result.html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
    });

    it("should escape HTML in email address", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "<script>alert('email')</script>@example.com",
      });

      expect(result.html).not.toContain("<script>alert('email')</script>");
      expect(result.html).toContain("&lt;script&gt;alert(&#039;email&#039;)&lt;/script&gt;");
    });

    it("should handle special characters in magic link", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc&foo=bar<baz>",
        email: "user@example.com",
      });

      expect(result.html).toContain("&lt;baz&gt;");
      expect(result.html).toContain("&amp;foo");
    });

    it("should include security warning section", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      expect(result.html).toContain("Didn't request this?");
      expect(result.html).toContain("safely ignore this email");
    });

    it("should include dark mode support", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      expect(result.html).toContain("prefers-color-scheme: dark");
    });

    it("should include mobile responsive styles", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      expect(result.html).toContain("@media screen and (max-width: 600px)");
    });

    it("should include preview text for email clients", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      expect(result.html).toContain("Preview text");
      expect(result.html).toContain('style="display: none; max-height: 0; overflow: hidden;"');
    });

    it("should include both button and fallback link", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      // Button
      expect(result.html).toContain("Sign in to Stratum");
      expect(result.html).toContain('class="button"');

      // Fallback link
      expect(result.html).toContain("copy and paste this link");
    });

    it("should include recipient email in footer", () => {
      const result = getMagicLinkEmail({
        magicLink: "https://example.com/verify?token=abc",
        email: "user@example.com",
      });

      expect(result.html).toContain("Sent to user@example.com");
    });
  });

  describe("wrapEmail", () => {
    it("should wrap content with Stratum branding", () => {
      const result = wrapEmail({
        title: "Test Email",
        body: "<p>Test content</p>",
      });

      expect(result).toContain("<!DOCTYPE html>");
      expect(result).toContain("<title>Test Email</title>");
      expect(result).toContain("<p>Test content</p>");
      expect(result).toContain("stratum");
      expect(result).toContain("Your code management platform");
    });

    it("should include dark mode support", () => {
      const result = wrapEmail({
        title: "Test",
        body: "<p>Test</p>",
      });

      expect(result).toContain("prefers-color-scheme: dark");
    });

    it("should include mobile responsive styles", () => {
      const result = wrapEmail({
        title: "Test",
        body: "<p>Test</p>",
      });

      expect(result).toContain("@media screen and (max-width: 600px)");
    });

    it("should include bgcolor attribute for older email clients", () => {
      const result = wrapEmail({
        title: "Test",
        body: "<p>Test</p>",
      });

      expect(result).toContain('bgcolor="#0f0f0f"');
    });
  });
});

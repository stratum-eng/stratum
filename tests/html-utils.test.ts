import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/utils/html";

describe("HTML Utilities", () => {
  describe("escapeHtml", () => {
    it("should escape HTML special characters", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toBe(
        "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
      );
    });

    it("should escape ampersand", () => {
      expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    });

    it("should escape double quotes", () => {
      expect(escapeHtml('class="test"')).toBe("class=&quot;test&quot;");
    });

    it("should escape single quotes", () => {
      expect(escapeHtml("value='test'")).toBe("value=&#039;test&#039;");
    });

    it("should escape less than and greater than", () => {
      expect(escapeHtml("<div>content</div>")).toBe("&lt;div&gt;content&lt;/div&gt;");
    });

    it("should handle empty string", () => {
      expect(escapeHtml("")).toBe("");
    });

    it("should handle string with no special characters", () => {
      expect(escapeHtml("Hello World")).toBe("Hello World");
    });

    it("should handle complex XSS payloads", () => {
      const xssPayload = `<img src=x onerror="alert('XSS')">`;
      expect(escapeHtml(xssPayload)).toBe(
        "&lt;img src=x onerror=&quot;alert(&#039;XSS&#039;)&quot;&gt;",
      );
    });

    it("should handle multiple occurrences", () => {
      expect(escapeHtml("<<test>>")).toBe("&lt;&lt;test&gt;&gt;");
    });

    it("should preserve already escaped entities correctly", () => {
      // Note: This will double-escape, which is the safe behavior
      expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    });
  });
});

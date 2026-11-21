import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getHeadChildNodes,
  getRelativeUrl,
} from "../../app/api/links/metatags/utils";

const PAGE = "https://example.com/blog/post";

describe("getRelativeUrl (metatags image resolution)", () => {
  it("keeps publicly-hosted absolute image URLs", () => {
    expect(getRelativeUrl(PAGE, "https://cdn.example.com/og.jpg")).toBe(
      "https://cdn.example.com/og.jpg",
    );
    expect(getRelativeUrl(PAGE, "http://images.example.com/og.png")).toBe(
      "http://images.example.com/og.png",
    );
  });

  it("resolves root-relative image URLs against the page origin", () => {
    expect(getRelativeUrl(PAGE, "/og.jpg")).toBe("https://example.com/og.jpg");
  });

  it("resolves path-relative image URLs against the page URL path", () => {
    expect(getRelativeUrl(PAGE, "cover.png")).toBe(
      "https://example.com/blog/cover.png",
    );
    expect(getRelativeUrl(PAGE, "./cover.png")).toBe(
      "https://example.com/blog/cover.png",
    );
    expect(getRelativeUrl(PAGE, "../images/cover.png")).toBe(
      "https://example.com/images/cover.png",
    );
  });

  it("resolves relative images against a custom base URL", () => {
    const base = "https://cdn.example.com/assets/";
    expect(getRelativeUrl(base, "hero.png")).toBe(
      "https://cdn.example.com/assets/hero.png",
    );
    expect(getRelativeUrl(base, "/root-hero.png")).toBe(
      "https://cdn.example.com/root-hero.png",
    );
  });

  it("extracts baseHref from <base> tag in getHeadChildNodes", () => {
    const html =
      '<head><base href="https://cdn.example.com/assets/"><meta property="og:image" content="image.png"></head>';
    const { baseHref } = getHeadChildNodes(html);
    expect(baseHref).toBe("https://cdn.example.com/assets/");
  });

  it("keeps inline base64 images", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect(getRelativeUrl(PAGE, dataUrl)).toBe(dataUrl);
  });

  // Regression: preview sites with a misconfigured Next.js metadataBase ship
  // og:image as http://localhost:3000/...; the scraper must drop these since
  // they can't be proxied and previously broke link creation.
  it("drops images on localhost / loopback / private hosts", () => {
    expect(
      getRelativeUrl(PAGE, "http://localhost:3000/images/og.jpg"),
    ).toBeNull();
    expect(getRelativeUrl(PAGE, "http://127.0.0.1:3000/og.jpg")).toBeNull();
    expect(getRelativeUrl(PAGE, "http://foo/og.jpg")).toBeNull();
  });

  it("returns null for empty or non-http(s) image values", () => {
    expect(getRelativeUrl(PAGE, "")).toBeNull();
    expect(getRelativeUrl(PAGE, "ftp://files.example.com/og.jpg")).toBeNull();
  });
});

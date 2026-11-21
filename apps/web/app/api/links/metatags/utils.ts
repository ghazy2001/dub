import { safeFetch } from "@/lib/api/safe-fetch";
import { recordMetatags } from "@/lib/upstash";
import {
  linkPreviewImageBase64PrefixRegex,
  publicHostedImageSchema,
} from "@/lib/zod/schemas/images";
import { waitUntil } from "@vercel/functions";
import he from "he";
import { parse } from "node-html-parser";

// Meta tags are in the <head>, which ends before 1 MB on real pages (the largest
// head we checked was about 760 KB). Only this much of a page is read.
export const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB

const HEAD_END_REGEX = /<\/head\s*>/i;
const CHARSET_REGEX = /<meta\s+[^>]*?charset\s*=\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i;
const HTTP_EQUIV_CHARSET_REGEX =
  /<meta\s+[^>]*?content\s*=\s*['"][^'"]*?charset\s*=\s*([a-zA-Z0-9_\-]+)['"]?/i;

const getCharsetFromContentType = (
  contentType: string | null,
): string | null => {
  if (!contentType) return null;
  const match = /charset\s*=\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i.exec(contentType);
  return match ? match[1] : null;
};

const createTextDecoder = (encoding?: string | null): TextDecoder => {
  if (encoding) {
    try {
      return new TextDecoder(encoding.trim());
    } catch {
      // Unknown or unsupported encoding, fallback to UTF-8
    }
  }
  return new TextDecoder("utf-8");
};

// Reads the body as text up to the end of the <head>, because getMetaTags
// needs only the meta, title and link tags. Reads at most maxBytes, so a page
// with no </head> near the start is cut at maxBytes.
export const readHtmlHead = async (response: Response, maxBytes: number) => {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  let bytesRead = 0;
  let text = "";

  const headerCharset = getCharsetFromContentType(
    response.headers.get("content-type"),
  );

  let decoder = createTextDecoder(headerCharset);
  let detectedCharset = headerCharset;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = maxBytes - bytesRead;
    const bytes =
      value.byteLength > remaining ? value.subarray(0, remaining) : value;
    bytesRead += bytes.byteLength;
    chunks.push(bytes);

    const atLimit = bytesRead >= maxBytes;
    const searchFrom = Math.max(0, text.length - "</head>".length);

    if (!detectedCharset) {
      let sampleLength = 0;
      for (const c of chunks) sampleLength += c.byteLength;
      const sampleBytes = new Uint8Array(Math.min(sampleLength, 2048));
      let offset = 0;
      for (const c of chunks) {
        const toCopy = Math.min(c.byteLength, sampleBytes.length - offset);
        sampleBytes.set(c.subarray(0, toCopy), offset);
        offset += toCopy;
        if (offset >= sampleBytes.length) break;
      }
      const sampleText = new TextDecoder("latin1").decode(sampleBytes);
      const metaMatch =
        CHARSET_REGEX.exec(sampleText) ||
        HTTP_EQUIV_CHARSET_REGEX.exec(sampleText);

      if (metaMatch) {
        detectedCharset = metaMatch[1];
        decoder = createTextDecoder(detectedCharset);
        text = "";
        for (let i = 0; i < chunks.length; i++) {
          const isLast = atLimit && i === chunks.length - 1;
          text += decoder.decode(chunks[i], { stream: !isLast });
        }
      } else {
        text += decoder.decode(bytes, { stream: !atLimit });
      }
    } else {
      text += decoder.decode(bytes, { stream: !atLimit });
    }

    const headEnd = HEAD_END_REGEX.exec(text.slice(searchFrom));
    if (headEnd) {
      await reader.cancel().catch(() => {});
      return text.slice(0, searchFrom + headEnd.index + headEnd[0].length);
    }

    if (atLimit) {
      await reader.cancel().catch(() => {});
      return text;
    }
  }

  return text + decoder.decode();
};

export const getHtml = async (url: string) => {
  try {
    const response = await safeFetch(url);

    if (!response.ok) {
      // If we get a 406 or other error, check if it's a Cloudflare-protected site
      const isCloudflare = response.headers.get("server") === "cloudflare";
      if (isCloudflare) {
        console.warn(`Cloudflare-protected site detected: ${url}`);
        return null;
      }
      console.error(`HTTP error! status: ${response.status} for URL: ${url}`);
      return null;
    }

    // Cloudflare sets this header on its challenge pages. readHtmlHead reads only
    // the <head>, so the text check below can miss a challenge page.
    if (response.headers.get("cf-mitigated") === "challenge") {
      await response.body?.cancel().catch(() => {});
      console.warn(`Cloudflare challenge page detected for: ${url}`);
      return null;
    }

    const text = await readHtmlHead(response, MAX_HTML_BYTES);

    // Check if the response contains Cloudflare's challenge page
    if (
      text.includes("challenge-platform") ||
      text.includes("cf-browser-verification")
    ) {
      console.warn(`Cloudflare challenge page detected for: ${url}`);
      return null;
    }

    return text;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
};

export const getHeadChildNodes = (html: string) => {
  const ast = parse(html); // parse the html into AST format with node-html-parser
  const metaTags = ast.querySelectorAll("meta").map(({ attributes }) => {
    const property = attributes.property || attributes.name || attributes.href;
    return {
      property,
      content: attributes.content,
    };
  });
  const title = ast.querySelector("title")?.innerText;
  const linkTags = ast.querySelectorAll("link").map(({ attributes }) => {
    const { rel, href } = attributes;
    return {
      rel,
      href,
    };
  });
  const baseHref = ast.querySelector("base")?.getAttribute("href") || null;

  return { metaTags, title, linkTags, baseHref };
};

export const getRelativeUrl = (url: string, imageUrl: string) => {
  if (!imageUrl) {
    return null;
  }
  let resolved: string;
  try {
    resolved = new URL(imageUrl, url).toString();
  } catch {
    return null;
  }
  if (linkPreviewImageBase64PrefixRegex.test(resolved)) {
    return resolved;
  }
  // Apply the same image rule as link creation so a scraped preview can't block it:
  // publicHostedImageSchema drops non-public hosts (localhost, IPs) that can't be proxied.
  if (publicHostedImageSchema.safeParse(resolved).success) {
    return resolved;
  }
  return null;
};

const generateFallbackMetadata = (url: string) => {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const path = parsedUrl.pathname;

    // Clean up the path for title
    const pathParts = path.split("/").filter(Boolean);
    const lastPathPart = pathParts[pathParts.length - 1] || "";
    const formattedPath = lastPathPart
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      title: formattedPath || hostname.replace(/^www\./, ""),
      description: `Visit ${hostname}${path}`,
      image: null,
    };
  } catch (e) {
    return {
      title: url,
      description: "No description available",
      image: null,
    };
  }
};

export const getMetaTags = async (url: string) => {
  const html = await getHtml(url);
  if (!html) {
    // If we couldn't fetch the HTML (e.g., due to Cloudflare protection),
    // generate fallback metadata from the URL
    return generateFallbackMetadata(url);
  }

  const {
    metaTags,
    title: titleTag,
    linkTags,
    baseHref,
  } = getHeadChildNodes(html);

  let targetUrl = url;
  if (baseHref) {
    try {
      targetUrl = new URL(baseHref, url).toString();
    } catch {
      // ignore invalid baseHref and fallback to url
    }
  }

  let object = {};

  for (let k in metaTags) {
    let { property, content } = metaTags[k];

    // !object[property] → (meaning we're taking the first instance of a metatag and ignoring the rest)
    property &&
      !object[property] &&
      (object[property] = content && he.decode(content));
  }

  for (let m in linkTags) {
    let { rel, href } = linkTags[m];

    // !object[rel] → (ditto the above)
    rel && !object[rel] && (object[rel] = href);
  }

  const title = object["og:title"] || object["twitter:title"] || titleTag;

  const description =
    object["description"] ||
    object["og:description"] ||
    object["twitter:description"];

  const image =
    object["og:image"] ||
    object["twitter:image"] ||
    object["image_src"] ||
    object["icon"] ||
    object["shortcut icon"];

  waitUntil(recordMetatags(url, title && description && image ? false : true));

  return {
    title: title || url,
    description: description || "No description",
    image: getRelativeUrl(targetUrl, image),
  };
};

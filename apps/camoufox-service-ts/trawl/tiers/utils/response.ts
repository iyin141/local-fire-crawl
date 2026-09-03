export interface MinimalResponse {
  url(): string
  status(): number
  headers(): Record<string, string>
  allHeaders(): Promise<Record<string, string>>
  body(): Promise<Buffer | Uint8Array>
}

export interface CapturedResponse {
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
}

const TEXT_CONTENT_MARKERS = ["html", "xml", "json", "javascript", "ecmascript", "x-www-form-urlencoded"]

export const isTextContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase()
  return normalized.startsWith("text/") || TEXT_CONTENT_MARKERS.some((marker) => normalized.includes(marker))
}

export const captureResponse = async (response?: MinimalResponse): Promise<CapturedResponse> => {
  if (!response) return {}
  try {
    const raw = await response.body()
    const responseHeaders = await response.allHeaders()
    return {
      body: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
      responseHeaders,
      contentType: responseHeaders["content-type"] ?? "application/octet-stream",
    }
  } catch {
    return {}
  }
}

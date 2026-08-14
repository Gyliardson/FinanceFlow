# OCR trust and validation model

FinanceFlow treats OCR/AI output as **untrusted suggestions**, never as authoritative financial state.

## Production flow

`authenticated request -> bounded upload read -> signature/MIME check -> structural parse/decode -> metadata-minimized OCR copy -> OCR provider -> strict structured-output parser -> manual-review suggestion`

The production `/upload-receipt` route is installed by `runtime:create_app`. It replaces the legacy handler and accepts only JPEG, PNG, WebP or PDF documents whose declared MIME agrees with the detected signature and whose structure can be parsed safely. The upload is bounded by the same 10 MiB policy used for private receipt documents.

Structural admission is deliberately stricter than a magic-byte check:

- JPEG, PNG and WebP inputs must be recognized by Pillow, match the expected encoding, have positive dimensions, stay within a 25,000,000-pixel processing budget, pass image verification and fully decode without truncation/corruption;
- PDFs must parse with pypdf in strict mode, be unencrypted, contain at least one page and no more than 25 pages, and expose a valid page tree;
- malformed/truncated content is rejected before storage or external OCR even when its leading bytes resemble a supported format.

These limits are defense-in-depth against malformed input and resource-exhaustion behavior; the 10 MiB byte limit remains the first bound.

## Metadata/privacy boundary

External OCR does **not** receive the original accepted file bytes.

Before third-party processing, FinanceFlow constructs a metadata-minimized representation:

- images are orientation-normalized and re-encoded without EXIF/XMP or other unnecessary source metadata;
- PDFs are rebuilt from their validated pages without carrying the source document metadata dictionary into the provider copy.

This transformation is specific to the external OCR boundary. A private receipt attached to a payment may retain the user's original **validated** bytes in owner-scoped private storage so evidence is not destructively rewritten. Therefore a privately stored original may retain source metadata, but that metadata is not intentionally forwarded to the OCR provider. Receipt access remains authenticated and time-bounded under the private-storage policy.

If metadata minimization cannot complete safely, the OCR request fails closed rather than sending the original bytes as a fallback.

## Provider boundary

`OcrProvider` is intentionally small. Production uses the Gemini adapter; tests use deterministic fakes. Critical CI must not require a Gemini key, network call or stochastic response.

The production adapter uses Google's maintained `google-genai` SDK and the configured Gemini model. The provider boundary exists so model/SDK lifecycle changes can be handled without changing the domain parser or CI contract. Model changes must be checked against Google's current model/deprecation documentation rather than inferred from old code comments.

Raw provider text is untrusted. `parse_ocr_output` accepts only a JSON object with these fields:

- `amount`: exact decimal or `null`; normalized to FinanceFlow's two-decimal money semantics and bounded to the supported financial range;
- `due_date`: strict ISO `YYYY-MM-DD` date or `null`;
- `barcode`: bounded string or `null`;
- `confidence`: decimal from `0` through `1` or `null`.

Unexpected fields, malformed JSON, invalid field types/ranges and impossible dates fail closed. A response wrapped exactly in a JSON code fence can be normalized, but surrounding prose is rejected.

## Manual review

OCR output is not persisted automatically. `needs_manual_review` is true when:

- the document is unreadable/all extracted values are null;
- confidence is below `0.70`;
- confidence is missing.

The client may present extracted values as editable suggestions. Any subsequent financial operation must pass through the normal authenticated/validated API and domain rules; OCR does not bypass ownership, RLS, exact-money validation or bill validation.

## Failure and privacy behavior

Provider timeout, rate limit, unavailability, malformed output and unexpected provider failure map to stable public categories/messages. Provider exception text, prompts, credentials and document bytes must never be returned to the client or copied into application error logs.

The OCR response does not echo the uploaded filename. Tests generate synthetic documents locally and do not contain real receipts, PII or financial records.

## Testing

The deterministic suite covers valid extraction, exact decimal rounding, malformed/noisy JSON, wrong field types and ranges, impossible dates, overlong barcode, unreadable/low-confidence output, timeout, 429, provider outage/unexpected failure, zero-byte/oversized/spoofed uploads, magic-prefix-only payloads, truncated JPEG/PNG/WebP/PDF inputs, image pixel-budget enforcement, image EXIF removal, PDF metadata removal and production runtime route replacement.

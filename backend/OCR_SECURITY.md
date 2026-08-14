# OCR trust and validation model

FinanceFlow treats OCR/AI output as **untrusted suggestions**, never as authoritative financial state.

## Production flow

`authenticated request -> bounded upload read -> actual-content validation -> OCR provider -> strict structured-output parser -> manual-review suggestion`

The production `/upload-receipt` route is installed by `runtime:create_app`. It replaces the legacy handler and accepts only validated JPEG, PNG, WebP or PDF bytes whose declared MIME agrees with their signature. The upload is bounded by the same 10 MiB policy used for receipt documents.

## Provider boundary

`OcrProvider` is intentionally small. Production uses the Gemini adapter; tests use deterministic fakes. Critical CI must not require a Gemini key, network call or stochastic response.

The production adapter uses Google's maintained `google-genai` SDK and the stable `gemini-3.6-flash` model. The provider boundary exists so model/SDK lifecycle changes can be handled without changing the domain parser or CI contract. Model changes must be checked against Google's current model/deprecation documentation rather than inferred from old code comments.

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

The OCR response does not echo the uploaded filename. Tests use synthetic documents only.

## Testing

The deterministic suite covers valid extraction, exact decimal rounding, malformed/noisy JSON, wrong field types and ranges, impossible dates, overlong barcode, unreadable/low-confidence output, timeout, 429, provider outage/unexpected failure, zero-byte/oversized/spoofed uploads, and production runtime route replacement.

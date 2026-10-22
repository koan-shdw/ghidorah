"""Keep Google's structured quota refusals separate from prepaid-credit errors."""


def refusal(body, model):
    error = body.get('error') if isinstance(body, dict) else None
    if not isinstance(error, dict) or error.get('status') != 'RESOURCE_EXHAUSTED':
        return None
    details = error.get('details')
    if not isinstance(details, list):
        return None
    violations = []
    for detail in details:
        if isinstance(detail, dict) and detail.get('@type') == 'type.googleapis.com/google.rpc.QuotaFailure':
            items = detail.get('violations')
            if isinstance(items, list):
                violations.extend(item for item in items if isinstance(item, dict) and
                                  str(item.get('quotaMetric', '')).startswith('generativelanguage.googleapis.com/'))
    if not violations:
        return None
    model_scoped = all(isinstance(item.get('quotaDimensions'), dict) and
                       isinstance(item['quotaDimensions'].get('model'), str) and
                       bool(item['quotaDimensions']['model']) for item in violations)
    # RetryInfo is a minimum retry delay, not proof of a daily quota reset.
    # Preserve the refusal until explicit retry; never invent a reset time.
    return dict(provider='gemini', model=model, layer='provider',
                code='model_quota_exhausted' if model_scoped else 'quota_exhausted')


def classify(error, *, status_code, error_code, model='', **kwargs):
    if status_code != 429:
        return None
    response = getattr(error, 'response', None)
    try:
        body = response.json() if response is not None else None
    except (ValueError, RuntimeError):
        body = None
    if error_code == 'trismegistus_quota_exhausted' or refusal(body, model):
        return dict(reason='rate_limit', retryable=False, should_rotate_credential=False, should_fallback=False)

"""Region-scoped Model Studio connection stored atomically with its API key."""
import json
import re

REGIONS = ('ap-southeast-1', 'cn-beijing', 'us-east-1', 'cn-hongkong', 'ap-northeast-1', 'eu-central-1')
SHARED = {'ap-southeast-1': 'dashscope-intl.aliyuncs.com', 'cn-beijing': 'dashscope.aliyuncs.com',
          'us-east-1': 'dashscope-us.aliyuncs.com', 'cn-hongkong': 'cn-hongkong.dashscope.aliyuncs.com'}


def refusal(body, model):
    if not isinstance(body, dict):
        return None
    error = body.get('error', body)
    if not isinstance(error, dict):
        return None
    raw_code = error.get('code')
    code = {'AllocationQuota.FreeTierOnly': 'model_quota_exhausted',
            'AccessDenied.Unpurchased': 'model_entitlement'}.get(raw_code) if isinstance(raw_code, str) else None
    return dict(provider='alibaba', model=model, layer='provider', code=code) if code else None


def classify(error, *, status_code, error_code, **kwargs):
    if status_code == 403 and error_code in ('AllocationQuota.FreeTierOnly', 'AccessDenied.Unpurchased'):
        # Both deny this model; neither invalidates the key. The request owner
        # retains the precise quota/entitlement reason for the desktop.
        return dict(reason='model_entitlement', retryable=False, should_rotate_credential=False, should_fallback=False)


def configuration(region='ap-southeast-1', workspace=''):
    if region not in REGIONS or not isinstance(workspace, str):
        raise ValueError('Choose a Model Studio region.')
    workspace = workspace.strip()
    if workspace and not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', workspace):
        raise ValueError('Enter the workspace ID shown in Model Studio.')
    if not workspace and region not in SHARED:
        raise ValueError('This region requires a Model Studio workspace ID.')
    domain = workspace + '.' + region + '.maas.aliyuncs.com' if workspace else SHARED[region]
    return dict(region=region, workspaceId=workspace, baseUrl='https://' + domain + '/compatible-mode/v1')


def read(raw):
    value = raw.decode() if raw else ''
    if value.startswith('{'):
        saved = json.loads(value)
        return saved['key'], configuration(saved['region'], saved['workspaceId'])
    return value, configuration()


def encode(key, region='ap-southeast-1', workspace=''):
    config = configuration(region, workspace)
    return json.dumps(dict(key=key, region=config['region'], workspaceId=config['workspaceId'])).encode()

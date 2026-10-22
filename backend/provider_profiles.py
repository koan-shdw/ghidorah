"""App-supplied profiles using Hermes's public provider registration interface."""
def install():
    from providers import register_provider, get_provider_profile
    from dataclasses import replace
    from alibaba_connection import classify
    from providers.base import ProviderProfile
    from hermes_cli.auth_plugin_providers import sync_plugin_provider_registry
    register_provider(replace(get_provider_profile('alibaba'), name='alibaba', classify_api_error=classify))
    from gemini_quota import classify as classify_gemini_quota
    register_provider(replace(get_provider_profile('gemini'), name='gemini', classify_api_error=classify_gemini_quota))
    register_provider(ProviderProfile(name='mistral', display_name='Mistral',
        base_url='https://api.mistral.ai/v1', env_vars=('MISTRAL_API_KEY', 'MISTRAL_BASE_URL'),
        signup_url='https://console.mistral.ai/'))
    sync_plugin_provider_registry()
    register_provider(ProviderProfile(name='openrouter-api', display_name='OpenRouter',
        base_url='https://openrouter.ai/api/v1', env_vars=('OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'),
        signup_url='https://openrouter.ai/keys'))
    sync_plugin_provider_registry()

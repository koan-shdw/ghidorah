"""Corrections stay in the task; skill writes require a user request."""
from agent.prompt_builder import build_memory_guidance, SKILLS_GUIDANCE


def test_task_corrections_do_not_schedule_skill_writes():
    guidance = build_memory_guidance(True, True) + SKILLS_GUIDANCE
    assert 'when the user asks' in guidance
    assert 'ordinary task corrections directly' in guidance
    assert 'record it with skill_manage' not in guidance
    assert 'Skills come first' not in guidance
    assert '[SKILL_PRUNED]' in guidance
    assert 'skill_manage' not in build_memory_guidance(True, True, skill_manage_available=False)

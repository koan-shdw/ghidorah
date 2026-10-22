from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import app_watch

ATOM = '''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<entry><title>New video model</title><link href="https://www.youtube.com/watch?v=new"/><published>2026-10-07T10:00:00+00:00</published>
<media:group><media:description>Open weights &lt;b&gt;release&lt;/b&gt;</media:description></media:group></entry>
<entry><title>Old video</title><link href="https://www.youtube.com/watch?v=old"/><published>2026-01-01T10:00:00+00:00</published></entry>
</feed>'''
RSS = '''<rss><channel><item><title>Reddit post</title><link>https://www.reddit.com/r/x/1</link>
<pubDate>Wed, 07 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Workflow&lt;/p&gt;</description></item></channel></rss>'''


def test_native_completion_reuses_prompts_and_validates_responses_without_api_calls():
    import json
    original = app_watch.summary_completion
    def unexpected(*args, **kwargs):
        raise AssertionError('Native completions must not call an API provider')
    app_watch.summary_completion = unexpected
    try:
        for stage, prompt, result in [('profile', app_watch.PROFILE_PROMPT, {'sources': 'News'}),
                                      ('queries', app_watch.QUERY_PROMPT, {'queries': ['new models']}),
                                      ('ideas', app_watch.IDEAS_PROMPT, {'ideas': []})]:
            request = {'stage': stage, 'context': {'brief': 'my words'}}
            prepared = app_watch.watch({**request, 'prepare': True}, 'ns')
            assert prepared['system'] == prompt and json.loads(prepared['prompt']) == request['context']
            answer = app_watch.watch({**request, 'response': '```json\n' + json.dumps(result) + '\n```'}, 'ns')
            assert all(answer[key] == value for key, value in result.items())
        for response in [None, '[]', 'not json', 'x' * 60001]:
            try:
                app_watch.watch({'stage': 'ideas', 'context': {}, 'response': response}, 'ns')
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid native response accepted')
    finally:
        app_watch.summary_completion = original


def test_source_lines_map_to_feeds_without_network():
    assert app_watch.feed_url('r/StableDiffusion', 'ns') == 'https://www.reddit.com/r/StableDiffusion/.rss'
    assert app_watch.feed_url('https://www.reddit.com/r/comfyui/', 'ns') == 'https://www.reddit.com/r/comfyui/.rss'
    channel = 'UC' + 'a' * 22
    assert app_watch.feed_url('https://www.youtube.com/channel/' + channel, 'ns') == 'https://www.youtube.com/feeds/videos.xml?channel_id=' + channel
    assert app_watch.feed_url('https://blog.example/feed.xml', 'ns') == 'https://blog.example/feed.xml'
    assert app_watch.feed_url('Two Minute Papers news', 'ns') is None


def test_feeds_keep_recent_items_with_plain_excerpts():
    since = app_watch.timestamp('2026-10-01T00:00:00Z')
    atom = app_watch.feed_items(ATOM, 'YouTube: Fireship', since)
    assert [item['title'] for item in atom] == ['New video model']
    assert atom[0]['excerpt'] == 'Open weights release' and atom[0]['source'] == 'YouTube: Fireship'
    rss = app_watch.feed_items(RSS, 'r/x', since)
    assert rss[0]['url'] == 'https://www.reddit.com/r/x/1' and rss[0]['excerpt'] == 'Workflow'
    assert rss[0]['published'] == app_watch.timestamp('2026-10-07T10:00:00Z')


def test_github_repos_read_releases_and_pages_link_their_feeds():
    assert app_watch.feed_url('https://github.com/comfyanonymous/ComfyUI', 'ns') == 'https://github.com/comfyanonymous/ComfyUI/releases.atom'
    assert app_watch.feed_url('https://github.com/huggingface/diffusers/releases', 'ns') == 'https://github.com/huggingface/diffusers/releases.atom'
    assert app_watch.feed_url('https://github.com/Wan-Video', 'ns') == 'https://github.com/Wan-Video'
    page = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml?a=1&amp;b=2"></head></html>'
    assert app_watch.discover(page, 'https://blog.example/news/') == 'https://blog.example/feed.xml?a=1&b=2'
    assert app_watch.discover('<html></html>', 'https://x.example') is None
    assert app_watch.is_feed(ATOM) and app_watch.is_feed(RSS) and not app_watch.is_feed(page) and not app_watch.is_feed('<html><body/></html>')


def test_captions_and_full_descriptions_are_plain_text():
    assert app_watch.caption_text('<transcript><text start="0">Hello &amp;#39;world&amp;#39;</text><text start="1">new model</text></transcript>') == "Hello 'world' new model"
    assert app_watch.caption_text('<timedtext><body><p t="0"><s>Open</s><s> weights</s></p></body></timedtext>') == 'Open weights'
    long = ATOM.replace('Open weights &lt;b&gt;release&lt;/b&gt;', 'x' * 1500)
    assert len(app_watch.feed_items(long, 'y', 0)[0]['excerpt']) == 1500


def test_gather_reads_up_to_the_limit_counts_captions_and_keeps_the_budget():
    video = lambda n: f'<entry><title>V{n}</title><link href="https://www.youtube.com/watch?v=vid{n:08d}"/><published>2026-10-1{n}T10:00:00+00:00</published></entry>'
    feeds = {'https://www.youtube.com/feeds/videos.xml?channel_id=UC' + 'a' * 22: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Chan</title>' + video(1) + video(2) + video(3) + '</feed>',
             'https://site.example/': '<html><link rel="alternate" type="application/atom+xml" href="/atom"></html>',
             'https://site.example/atom': ATOM, 'https://www.reddit.com/r/xy/.rss': RSS}
    said = {'https://www.youtube.com/watch?v=vid00000001': None, 'https://www.youtube.com/watch?v=vid00000002': 'b' * 70, 'https://www.youtube.com/watch?v=vid00000003': 'c' * 70}
    saved = app_watch.fetch, app_watch.captions, app_watch.research, app_watch.TRANSCRIPT_BUDGET
    app_watch.fetch, app_watch.captions, app_watch.TRANSCRIPT_BUDGET = lambda url, *a: feeds[url], said.get, 100
    app_watch.research = lambda call, ns: {'results': [{'url': 'https://news.example/a', 'title': 'Found', 'description': 'd'}]}
    try:
        lines = ['https://www.youtube.com/channel/UC' + 'a' * 22, 'https://site.example/', 'r/xy', 'Plain words'] + ['https://none%d.example/' % n for n in range(40)]
        feeds.update({'https://none%d.example/' % n: '<html></html>' for n in range(40)})
        result = app_watch.gather({'since': 0, 'sources': '\n'.join(lines), 'queries': ['q'], 'reported': ['https://www.reddit.com/r/x/1']}, 'ns')
    finally:
        app_watch.fetch, app_watch.captions, app_watch.research, app_watch.TRANSCRIPT_BUDGET = saved
    rows = {row['line']: row for row in result['checked']}
    # Newest video keeps its captions; the next would pass the budget; the oldest has none.
    assert rows[lines[0]]['new'] == 3 and rows[lines[0]]['captions'] == 1 and 'captions' not in rows[lines[1]]
    assert rows['r/xy']['new'] == 0, 'A reported link is not new again'
    assert result['unchecked'][:2] == lines[40:42] and 'Plain words' in result['unchecked'] and len(result['unchecked']) == 41
    urls = [item['url'] for item in result['items']]
    assert urls[0].endswith('vid00000003') and urls[-1] == 'https://news.example/a', 'Source items come first, search fills in'
    assert [item.get('transcript') for item in result['items'][:3]] == ['c' * 70, None, None]

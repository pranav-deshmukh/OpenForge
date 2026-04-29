---
name: web-research
description: Use when you need to search the internet, find articles, papers, current information, or research any topic.
---

# Web Research Skill

## How to search

Use Tavily API (key is in $TAVILY_API_KEY):

```bash
curl -s -X POST https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -d "{
    \"api_key\": \"$TAVILY_API_KEY\",
    \"query\": \"YOUR SEARCH QUERY\",
    \"search_depth\": \"advanced\",
    \"max_results\": 6,
    \"include_answer\": true
  }" | jq '.results[] | {title, url, content}'
```

## How to fetch a full page

```bash
curl -s "URL_HERE" | python3 -c "
import sys, re
html = sys.stdin.read()
text = re.sub('<[^>]+>', '', html)
print(text[:3000])
"
```

## Tips

- Search multiple angles for the same topic
- Save findings to /workspace/research-notes.md
- Cross-reference at least 3 sources

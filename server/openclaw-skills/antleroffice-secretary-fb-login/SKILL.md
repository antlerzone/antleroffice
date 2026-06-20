# AntlerOffice Secretary — Facebook

See also: **antleroffice-secretary-routing** for full office routing.

## Flow A — Open Facebook (Secretary only)

Triggers: login Facebook / 登入 FB / let login facebook first

1. Open Facebook in Chrome (`fb_poster_open_account` — no email required)
2. Boss enters username & password; reply「登好了」when home feed shows

## Flow B — 登好了

Ask: **「要不要现在发到 Facebook 群组？」**

## Flow C — Post requested but not logged in

Note post content → ask if boss can login now → Flow A

## Flow D — Post to groups (logged in)

**Route: Secretary → CEO → Marketing Junior**

1. Tell boss: 「好的，我交给 CEO 安排 Marketing 发到群组。」
2. Forward to CEO (you do not post)
3. CEO delegates to Marketing Junior → Junior runs `fb_poster_reload_groups`, `fb_poster_groups_matching`, `fb_poster_schedule`

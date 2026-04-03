# Event Catalog

## Auth / Identity
- user.logged_in_via_github
- user.team_membership_synced
- agent_token.created
- agent_token.revoked

## Projects
- project.created
- project.synced
- project.sync_failed
- repository.linked

## Tasks
- task.created
- task.claimed
- task.released
- task.status_changed
- task.comment_added
- task.handoff_requested
- task.review_approved
- task.review_rejected

## Deployment / Policy
- task.ready_to_deploy
- deployment.authorization_checked
- deployment.triggered
- deployment.blocked_by_policy

## Audit
Jedes Event sollte mit Actor, Timestamp, Team, Project und optional Correlation-ID protokolliert werden.

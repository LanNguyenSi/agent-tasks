# Domain Model

## Kernentitäten
- Team
- User
- AgentIdentity
- AgentToken
- Project
- RepositoryReference
- Task
- Claim
- Board
- WorkflowDefinition
- WorkflowTransitionRule
- Comment
- ActivityLogEvent

## Beziehungen
- Ein `Team` hat viele `Users`
- Ein `Team` hat viele `AgentIdentities`
- Ein `Team` hat viele `Projects`
- Ein `Project` gehört genau zu einem `Team`
- Ein `Project` kann optional genau eine `RepositoryReference` besitzen
- Ein `Project` hat viele `Tasks`
- Eine `Task` gehört genau zu einem `Project`
- Eine `Task` kann null oder mehrere `Claims` haben
- Ein `Board` gehört zu einem `Team` oder `Project`
- Eine `WorkflowDefinition` gehört zu einem `Team` oder `Project`
- Eine `Task` hat viele `Comments`
- Eine `Task` hat viele `ActivityLogEvents`

## Wichtige Invarianten
- Ein Projekt ist entweder `manual` oder `github_synced`
- Eine Task gehört immer genau zu einem Projekt
- Ein Claim referenziert genau **einen** Bearbeiter: Human **oder** Agent
- Ein Agent darf nur innerhalb seiner Token-Scopes handeln
- Workflow-Übergänge müssen gegen Regeln validiert werden
- Kritische Transitionen können Human-Review erfordern
- Production-Deployment darf standardmäßig nicht ohne explizite Regel durch Agenten ausgelöst werden

## Fachliche Attribute

### Team
- id
- name
- slug
- source (manual/github)
- external_source_id

### User
- id
- team_id
- display_name
- email
- auth_provider
- external_provider_id
- role

### AgentIdentity
- id
- team_id
- name
- description
- status

### AgentToken
- id
- agent_identity_id
- label
- scopes
- expires_at
- revoked_at

### Project
- id
- team_id
- name
- slug
- source (manual/github_synced)
- repo_url
- default_board_id
- workflow_definition_id
- sync_status

### Task
- id
- project_id
- title
- description
- origin (human/agent/sync/webhook)
- status
- priority
- created_by_type
- created_by_id
- current_assignee_type
- current_assignee_id

### Claim
- id
- task_id
- claimant_type
- claimant_id
- mode (exclusive/collaborative)
- claimed_at
- released_at

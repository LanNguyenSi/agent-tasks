# State Machines

## Task Lifecycle

```text
todo
-> in_progress
-> in_review
-> changes_requested
-> approved
-> ready_to_deploy
-> deployed
-> done
-> cancelled
```

## Beispielregeln
- `todo -> in_progress`: nur mit gültigem Claim oder passenden Rechten
- `in_progress -> in_review`: Bearbeiter oder Workflow-Automation
- `in_review -> changes_requested`: Reviewer
- `in_review -> approved`: Reviewer
- `approved -> ready_to_deploy`: nur wenn Deploy-Policy erfüllt ist
- `ready_to_deploy -> deployed`: nur autorisierte Rolle
- `deployed -> done`: Deployment bestätigt
- `* -> cancelled`: nur berechtigte Humans/Admins

## Claim Lifecycle
```text
unclaimed
-> claimed_exclusive
-> released
```

oder

```text
unclaimed
-> claimed_collaborative
-> released
```

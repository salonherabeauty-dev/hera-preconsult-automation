# OAuth environment normalization hotfix

- Trims leading/trailing whitespace from Google OAuth client ID, client secret and refresh token before token refresh.
- Adds secret-free credential-shape telemetry to OAuth refresh failures.
- Does not log or expose credential values.
- Adds regression coverage for copied whitespace/newlines.

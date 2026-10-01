# Admin access and recoverable course deletion

This release extends the existing `admin` role. It adds no public admin bootstrap route and does not create, promote, suspend or reset any existing production account on deployment. Existing instructors remain active for explicit administrator review. Public registration now creates students only; both the validator and service reject instructor/admin roles. Login uses the stored role and has no role selector.

## First administrator: operator action required

From the updated backend checkout, in a trusted interactive terminal:

```sh
npm run bootstrap:admin
```

Prerequisites: installed backend dependencies; an existing protected environment or untracked `.env` containing `MONGO_URI` and explicit `MONGO_DB_NAME=lms`; database/network access to the intended deployment. Never paste these values into chat or commit them. A trusted local terminal can connect to Atlas when the hosting plan has no shell. Do not weaken Atlas network access merely to run this command.

The command prompts for a name, email, hidden password and confirmation, then requires typing the destination database name. **The operator enters and submits the password directly.** Use an address you control and a unique password of at least 16 characters, at most 72 UTF-8 bytes. There is no default password or preselected real account. Passwords in command arguments and pipes are rejected. Cancelling before the final confirmation creates nothing.

Bootstrap refuses if any administrator already exists and never promotes or overwrites an existing email. A sparse unique bootstrap key prevents two simultaneous commands from creating two first admins. Existing data needs no destructive migration. Do not retry blindly after a connection failure: inspect whether the account was created. The bootstrap audit record may remain pending after an interrupted operation. Operator recovery/another administrator requires a separately reviewed operation, not a public endpoint.

After bootstrap, use the normal HTTPS login page. Open `/admin`, choose **Create instructor**, enter the instructor's name/email and a temporary password. Save that password securely before submitting; the application never returns it. The administrator shares it privately outside the app. No transactional email provider is required for this path and no message is sent automatically.

Temporary passwords expire after 72 hours. Their sessions last at most one hour, and normal protected endpoints deny access until the instructor chooses a different private password of 12+ characters. An admin can replace an instructor's temporary password without restoring a suspended account. Password replacement, password change and account access changes invalidate old sessions using an account generation counter as well as session deletion. Existing sessions without a counter are treated as generation zero.

## Role matrix

| Capability | Student | Instructor | Admin |
| --- | --- | --- | --- |
| Public registration | Student account only | No | No |
| Sign in / change own password | Yes | Yes | Yes |
| Create instructors | No | No | Yes |
| List all students/instructors | No | No | Yes |
| Pause/restore student or instructor accounts | No | No | Yes |
| Alter admin access or reset an admin's password through management APIs | No | No | No |
| Create/manage/edit/archive/restore courses | No | Owned courses | All courses |
| Transfer course to another active instructor | No | No | Yes |
| Assign/revoke students and publish/unpublish | No | Owned courses | All courses |
| Read courses / obtain video tickets | Published, assigned, active courses | Owned active courses | All active courses |
| List all video metadata and admin activity | No | No | Yes |

A suspended account cannot sign in or use an old session. Restoring it requires a fresh sign-in. Pausing an instructor does **not** unpublish their courses or remove student assignments; use course publication/archive controls for that separate action. Transfer is blocked while pending uploads exist, preserves assignments, and removes the previous instructor's access on subsequent authorization checks. Requests already in flight may finish. Existing signed upload/playback URLs remain usable until their own expiration; received video bytes cannot be revoked.

Admin reads are paginated and use explicit response fields. Password hashes, reset tokens, session material and storage keys are excluded. Admin writes persist an audit intent before execution and record outcome/target after response; incomplete records remain visible as pending. No request bodies, query strings, cookies or signed URLs are logged by that audit mechanism. This is application auditing, not an externally immutable compliance archive.

## Course CRUD and deletion policy

Create a course as a draft, edit its title/description/category/level/language/requirements/outcomes, manage curriculum, then publish and assign students. Server ownership checks remain authoritative.

`DELETE /api/courses/:id` now archives rather than permanently deletes. It atomically marks the course archived and unpublished; new course/progress/video/upload access is denied immediately. Modules, lessons, video records, assignments and completion remain intact. Repeated archive is safe. `POST /api/courses/:id/restore` restores an archived course as a draft; repeated restore against an already active course does not unpublish it. Review and explicitly republish to reopen student access. A concurrent publish cannot override an archive. Both owner and admin can recover from the Archived courses view.

No R2 object is purged by course archive/restore. Storage continues to incur normal retention costs. There is no automatic permanent-delete schedule in this release. Existing lesson/video removal behavior is separate from recoverable whole-course archive. Interrupted direct uploads may expire while archived; after restoration, remove/re-upload those entries as needed. An orphan/expiry reconciler and reviewed retention/purge policy remain follow-up work. Do not attach a blanket lifecycle expiry to final `videos/` objects.

## Rollout order and verification

1. Deploy backend first, then frontend. No new mandatory environment variables or auth provider are introduced. Keep `NODE_ENV=production`, the exact HTTPS frontend `CLIENT_URL`, `/api` frontend API base, private R2 and the existing secure cookie configuration.
2. Backend-first compatibility: old student/teacher logins and existing data continue to work. Old signup screens attempting instructor registration receive a clear rejection. New admin controls need the new backend; wait for both deployments before onboarding.
3. Run the interactive bootstrap yourself if no admin exists. Review existing instructors explicitly; do not automatically revoke them.
4. Verify actual-domain login/reload/logout and cookie attributes. With approved synthetic hosted fixtures, check admin create → temporary login → private password → own-course access; pause/restore; create/edit/publish/archive/restore; student denial and completion preservation; instructor ownership separation.
5. Check audit outcomes, error logs and provider health. Keep a rollback reference, but **do not roll the backend back below this release after archiving courses or suspending accounts**: older code does not enforce archive/status fields. Prefer a forward fix or carefully reviewed data-aware rollback.

Local evidence: 40 backend tests pass (real isolated MongoDB/HTTP, legacy FFmpeg regression, new admin/race/CRUD cases; direct R2 calls mocked). Hosted admin provisioning is deliberately not performed by the agent. Existing local real-R2 evidence is in `verification.md` and does not establish hosted readiness or 100-user capacity.

-- aantje-template: 1
-- name: Change with a commit message
-- description: Runs a change in one transaction whose snapshot gets an author and a commit message.
-- tags: commit message, transaction, snapshot, author
-- created: 2026-11-16
-- param: author  | text |  | Who makes the change
-- param: message | text |  | Commit message of the snapshot
-- Write the statements of the change between the call and COMMIT. The message counts only inside a transaction.
-- When aantje asks for a commit message before a run that changes the lake (setting aantje.sql.askCommitMessage), the message you give there comes later and counts.
BEGIN TRANSACTION;
CALL lake.set_commit_message({{author}}, {{message}});
-- UPDATE main.my_table SET ... WHERE ...;
COMMIT;

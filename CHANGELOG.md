# Changelog

## Current Branch Notes

- Added and wired the Mission Control STT bridge so live speech activity and transcript updates can drive the dashboard core.
- Hardened transcript delta extraction so case and punctuation-only changes do not replay whole phrases into the holo core.
- Updated the holo core live transcript ribbon to avoid treating every shorter partial as a brand-new utterance.
- Increased trailing-word holdback on longer phrases so multi-word STT rewrites can settle before words are committed to the ring.
- Kept stop handling non-destructive for mid-utterance `speech raw=undefined` activity events, with time-based flush behavior still handling the held tail.

# Legal archive

The exact text of each version of the Terms of Service, Privacy Policy, Data
Processing Addendum and Your Privacy Choices page we have published. Each
folder is named for a date:

- An `ACCEPTANCE_VERSION` in `src/lib/legalVersion.ts`: the version customers
  were asked to accept. Each `TermsAcceptance` row in the database names the
  version it accepted, so an acceptance can always be matched to the words it
  covered.
- A later "Last updated" date (`LEGAL_LAST_UPDATED`) for a change that wasn't
  material, so it needed no new acceptance. 2026-10-26 added the Privacy
  Policy's "Videos" section, and 2026-10-27 changed it to say the videos
  play from our own website; people who accepted 2026-10-14 accepted that
  version.

Add a new folder, generated from the page source, whenever either date
changes. A test (`legalRecords.test.ts`) fails if the accepted version or the
printed date has no archive.

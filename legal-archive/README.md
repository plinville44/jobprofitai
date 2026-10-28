# Legal archive

The exact text of each version of the Terms of Service, Privacy Policy, Data
Processing Addendum and Your Privacy Choices page we have published. Each
folder is named for a date and holds all four documents as the site showed
them from that date on:

- An `ACCEPTANCE_VERSION` in `src/lib/legalVersion.ts`: the version customers
  were asked to accept. Each `TermsAcceptance` row in the database names the
  version it accepted, so an acceptance can always be matched to the words it
  covered.
- A later `LEGAL_LAST_UPDATED` for a change that wasn't material, so it
  needed no new acceptance. 2026-10-26 added the Privacy Policy's "Videos"
  section, 2026-10-27 changed it to say the videos play from our own
  website, and 2026-10-28 said which videos our emails link to on YouTube
  and that the player links there if a video can't load. People who
  accepted 2026-10-14 accepted that version.

Each document prints its own "Last updated" date (`LEGAL_UPDATED` in
`src/lib/legalVersion.ts`): the day its own text last changed. In the
2026-10-26 and 2026-10-27 folders all four printed that folder's date,
although only the Privacy Policy had changed. From 2026-10-28 the Terms,
the Addendum and Your Privacy Choices print October 14, 2026 again; their
text is word for word the 2026-10-14 text.

Add a new folder, generated from the page source, whenever any of these
dates changes. A test (`legalRecords.test.ts`) fails if the accepted version
or the newest date has no archive, if a page prints a date other than its
newest archived copy, or if a document's text changed after the date it
prints.

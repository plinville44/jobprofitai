# Legal archive

The exact text of each version of the Terms of Service, Privacy Policy, Data
Processing Addendum and Your Privacy Choices page that customers were asked to
accept. Each folder is named for an `ACCEPTANCE_VERSION` in
`src/lib/legalVersion.ts`, and each `TermsAcceptance` row in the database names
the version it accepted, so an acceptance can always be matched to the words it
covered.

Add a new folder, generated from the page source, whenever
`ACCEPTANCE_VERSION` changes. A test (`legalRecords.test.ts`) fails if the
current version has no archive.

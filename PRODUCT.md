# Product: Crosswire

Strategic context extracted from the existing locked [design system](DESIGN.md), sections 1 to 6.

## Register

product

## Users

SOC analysts investigate and propose searches. Approvers and owners decide on response actions;
owners configure the workspace. The interface supports long investigation sessions.

## Product Purpose

Connect threat intelligence watches to hunts, reviewed KQL searches, stored result samples and
human-approved response actions. Help analysts inspect evidence and provenance, then make an
informed decision about the exact action and targets.

## Brand Personality

Calm, precise and practical. Use plain Australian English, explicit action verbs and familiar
workflow terms. The workspace is an instrument for investigation.

## Anti-references

Avoid decorative dashboards, invented risk scores, entity graphs without relationship data,
and charts that imply a small stored sample is a complete tenant result set. Do not design
unimplemented workflows such as case assignment or detection-rule management.

## Design Principles

- Show provenance, data mode and uncertainty alongside evidence.
- Keep review and deliberate human approval central to tenant changes.
- Use consistent controls and predictable navigation across workflows.
- Keep dense information readable with quiet chrome and restrained emphasis.
- Make permissions and unavailable actions understandable; enforce them on the server.

## Accessibility & Inclusion

Meaning must not rely on colour alone. Preserve visible keyboard focus, labelled controls,
reduced-motion support, and usable narrow layouts. Light and dark themes follow the operating
system by default. Use the established UI primitives and the WCAG checks in the browser suite.

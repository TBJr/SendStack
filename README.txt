Email Marketing Platform - Project Documentation Pack

Version: 0.3
Date: 20 September 2026

Current implementation decision - 21 September 2026
----------------------------------------------------
The v0.3 DOCX files below remain the original self-hosted/direct-to-MX planning
baseline. They are reference documents, not active runtime instructions. The
current SendStack production target selected after that pack was issued is:

- Vercel application runtime
- Managed PostgreSQL system of record
- Resend Broadcasts delivery provider
- Cloudflare may remain the DNS host

See 04_Deployment_Handover/VERCEL_RESEND_DEPLOYMENT.md for the current handover
contract. Where that decision conflicts with the direct-to-MX plan described
below or in the DOCX files, the newer handover contract governs the application
implementation. The DOCX pack has not yet been regenerated.

Purpose
-------
This folder contains the revised client-ready documentation baseline for a self-hosted marketing email platform that includes a client-controlled outbound MTA and direct-to-MX delivery.

Architecture change in v0.3
---------------------------
- Replaces the mandatory client SMTP/API provider dependency with a client-controlled Postfix MTA.
- Initial production operating target is 2,000 emails/day on a 2 vCPU / 8 GB VPS, subject to DNS, reputation, receiver response and network readiness.
- Keeps the application/queue layer designed for larger synthetic campaign loads; higher live direct-to-MX volume requires explicit deliverability validation.
- Adds PTR/rDNS, SPF, DKIM, DMARC, bounce/DSN processing, destination-aware throttling, MTA queue observability and warm-up requirements.
- Optional third-party SMTP relay remains a contingency transport, not a required production dependency.

Files
-----
00_Governance/00_Document_Register_and_Governance.docx
01_Product/01_Project_Overview_and_Product_Brief.docx
01_Product/02_Scope_of_Work.docx
01_Product/03_Product_Roadmap.docx
02_UX_Wireframes/04_Wireframes_and_User_Flows.docx
03_Technical/05_Technical_Architecture_and_Requirements.docx
04_Deployment_Handover/06_Deployment_Handover_and_Acceptance.docx
05_Risk_Compliance/07_Risk_Compliance_and_Abuse_Controls.docx
06_Backlog_Acceptance/08_MVP_Backlog_and_Acceptance_Criteria.docx
07_Budget_Commercial/09_Project_Cost_Estimate_and_Budget.docx

Important production prerequisite
--------------------------------
Before provisioning the final mail server, confirm that the selected hosting account permits outbound SMTP on TCP port 25 and supports the required PTR/rDNS configuration. Current host restrictions are not assumed by this documentation.

Notes
-----
- Product name is a working title and can be replaced globally once branding is selected.
- Legal/compliance sections are product-planning material, not legal advice.
- Direct-to-MX delivery does not guarantee inbox placement; sender/domain/IP reputation remains an operational responsibility.
- DOC-09 contains planning cost estimates; current hosting/IP/monitoring pricing must be confirmed before contract signature.
- IP ownership and final commercial/legal terms remain subject to the signed agreement.

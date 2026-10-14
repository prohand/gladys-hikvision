# Security policy

## Supported versions

Only the latest release of the Hikvision integration receives security fixes. Update the
integration from the Gladys store before reporting an issue.

| Version      | Supported |
| ------------ | --------- |
| 1.x (latest) | Yes       |
| older        | No        |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of
[prohand/gladys-hikvision](https://github.com/prohand/gladys-hikvision/security), then **Report a
vulnerability**.

Include, when you can:

- the version of the integration and of Gladys;
- the model and firmware of the Hikvision device involved;
- what an attacker can do, and the steps to reproduce it;
- any log line that helps (remove passwords, serial numbers and addresses first).

You should get a first answer within 7 days. A fix is released as a new version of the
integration, and the advisory is published once users can update.

## Scope

In scope: the code of this repository and the Docker image it publishes.

Out of scope: Gladys Assistant itself (report to
[GladysAssistant/Gladys](https://github.com/GladysAssistant/Gladys/security)), and the Hikvision
devices and their firmware (report to the
[Hikvision Security Response Center](https://www.hikvision.com/en/support/cybersecurity/)).

## How the integration handles your devices

- It only talks to the addresses you configure, on your local network, over their ISAPI. Nothing
  is sent to a cloud service.
- The password is kept in a secret field of Gladys, sent with HTTP Digest authentication (never in
  clear when the device offers Digest), and never written to the logs. Credentials typed inside an
  address are refused.
- A refused password is never retried automatically, so the integration cannot lock your account.
- Only what the devices told it (model, serial number, channels) is stored, in `/data`.

## Good practices for users

- Create a dedicated user on each device with the **Operator** role, not `admin`.
- Keep the devices on a separate network or VLAN, and do not expose their web interface to the
  Internet.
- Keep the camera and recorder firmwares, Gladys and the integration up to date.

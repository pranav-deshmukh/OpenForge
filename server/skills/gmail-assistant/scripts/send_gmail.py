import argparse
import base64
import json
import os
from email.message import EmailMessage
from pathlib import Path

import requests

CONFIG_PATH = Path(os.environ.get("OPENFORGE_AGENT_MAIL_PATH", "/run/openforge/agent-mail.json"))
TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_config(config: dict) -> None:
    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)


def exchange_authorization_code(config: dict) -> str:
    authorization_code = (config.get("authorizationCode") or "").strip()
    redirect_uri = (config.get("redirectUri") or "").strip()
    client_secret = (config.get("clientSecret") or "").strip()
    if not authorization_code:
        raise RuntimeError(
            "Gmail is not connected. No refreshToken or authorizationCode is configured. "
            "Connect Gmail by saving an OAuth authorization code."
        )
    if not client_secret:
        raise RuntimeError(
            "Gmail is not connected. clientSecret is required to exchange an OAuth authorization code."
        )
    if not redirect_uri:
        raise RuntimeError(
            "Gmail is not connected. redirectUri is required to exchange an OAuth authorization code."
        )

    response = requests.post(
        TOKEN_URL,
        data={
            "client_id": config["clientId"],
            "client_secret": client_secret,
            "code": authorization_code,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    refresh_token = payload.get("refresh_token")
    access_token = payload.get("access_token")
    if not refresh_token:
        raise RuntimeError(
            "Google did not return a refresh token. Re-authorize with "
            "access_type=offline, prompt=consent, and the gmail.modify scope."
        )
    if not access_token:
        raise RuntimeError("Google did not return an access token.")

    config["refreshToken"] = refresh_token
    config["accessToken"] = access_token
    config.pop("authorizationCode", None)
    save_config(config)
    return access_token


def refresh_access_token(config: dict) -> str:
    refresh_token = config.get("refreshToken")
    if not refresh_token:
        return exchange_authorization_code(config)
    response = requests.post(
        TOKEN_URL,
        data={
            "client_id": config["clientId"],
            "client_secret": config["clientSecret"],
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload["access_token"]
    config["accessToken"] = token
    save_config(config)
    return token


def build_raw_message(config: dict, to: str, subject: str, body: str) -> str:
    msg = EmailMessage()
    from_name = config.get("displayName") or config["email"]
    msg["From"] = f"{from_name} <{config['email']}>"
    msg["To"] = to
    msg["Subject"] = subject
    final_body = body
    if config.get("signature"):
        final_body += f"\n\n{config['signature']}"
    msg.set_content(final_body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    return raw.rstrip("=")


def send_message(access_token: str, raw_message: str) -> dict:
    response = requests.post(
        SEND_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        json={"raw": raw_message},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--to", required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body", required=True)
    args = parser.parse_args()

    config = load_config()
    token = refresh_access_token(config)
    raw_message = build_raw_message(config, args.to, args.subject, args.body)
    result = send_message(token, raw_message)
    print(json.dumps({"status": "sent", "id": result.get("id")}))


if __name__ == "__main__":
    main()

import pytest

from imap_scraper import _imap_search_value, _search_allowed_unseen_ids


class FakeSearchMailbox:
    def __init__(self, messages, *, fail=False):
        self.messages = messages
        self.fail = fail
        self.calls = []

    def search(self, charset, *criteria):
        self.calls.append((charset, criteria))
        if self.fail:
            return "NO", [b""]

        sender = None
        subject = None
        for index, token in enumerate(criteria):
            if token == "FROM":
                sender = criteria[index + 1].strip('"').replace('\\"', '"').replace('\\\\', '\\')
            if token == "SUBJECT":
                subject = criteria[index + 1].strip('"').replace('\\"', '"').replace('\\\\', '\\')

        matched = []
        for item in self.messages:
            if not item["unseen"]:
                continue
            if sender is not None and sender.lower() not in item["from"].lower():
                continue
            if subject is not None and subject.lower() not in item["subject"].lower():
                continue
            matched.append(str(item["id"]).encode("ascii"))
        return "OK", [b" ".join(matched)]


def test_unrelated_unread_prefix_cannot_consume_allowlisted_budget():
    messages = [
        {
            "id": index,
            "unseen": True,
            "from": f"newsletter-{index}@unrelated.example",
            "subject": "Unrelated unread mail",
        }
        for index in range(1, 41)
    ]
    messages.append(
        {
            "id": 41,
            "unseen": True,
            "from": "billing@example.com",
            "subject": "Fatura de agosto",
        }
    )
    mail = FakeSearchMailbox(messages)

    result = _search_allowed_unseen_ids(
        mail,
        {"billing@example.com"},
        ("fatura",),
        max_messages=25,
    )

    assert result == [b"41"]
    assert mail.calls == [
        (None, ("UNSEEN", "FROM", '"billing@example.com"', "SUBJECT", '"fatura"')),
    ]


def test_multiple_senders_and_subject_tokens_are_deduplicated_before_cap():
    mail = FakeSearchMailbox(
        [
            {"id": 10, "unseen": True, "from": "a@example.com", "subject": "Invoice fatura"},
            {"id": 11, "unseen": True, "from": "b@example.com", "subject": "Invoice"},
            {"id": 12, "unseen": True, "from": "b@example.com", "subject": "Fatura"},
            {"id": 13, "unseen": False, "from": "a@example.com", "subject": "Invoice"},
        ]
    )

    result = _search_allowed_unseen_ids(
        mail,
        {"b@example.com", "a@example.com"},
        ("invoice", "fatura"),
        max_messages=2,
    )

    assert result == [b"12", b"11"]
    assert len(mail.calls) == 4
    assert all(call[1][0] == "UNSEEN" for call in mail.calls)
    assert all("FROM" in call[1] and "SUBJECT" in call[1] for call in mail.calls)


def test_search_failure_fails_closed_instead_of_falling_back_to_all_unread():
    mail = FakeSearchMailbox([], fail=True)

    with pytest.raises(RuntimeError, match="relevant-message search failed"):
        _search_allowed_unseen_ids(mail, {"billing@example.com"}, ("invoice",))

    assert len(mail.calls) == 1


def test_search_configuration_is_bounded_and_control_characters_are_rejected():
    with pytest.raises(ValueError, match="control characters"):
        _imap_search_value("billing@example.com\r\nUNSEEN")

    senders = {f"billing-{index}@example.com" for index in range(11)}
    tokens = tuple(f"subject-{index}" for index in range(10))
    mail = FakeSearchMailbox([])

    with pytest.raises(ValueError, match="beyond 100 queries"):
        _search_allowed_unseen_ids(mail, senders, tokens)

    assert mail.calls == []

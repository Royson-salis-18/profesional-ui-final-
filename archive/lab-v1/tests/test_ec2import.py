import yaml

from rcalab import config, ec2import, projects

# Shape of a copy from the EC2 console's Instances table (one field per line, tabs between).
PASTE = """Name\t\nInstance ID\t\nInstance state\t\nInstance type\t\nStatus check\t\nAvailability Zone\t
Public IPv4 DNS\t\nPublic IPv4 address\t\nElastic IP\t\nIPv6 IPs\t\nMonitoring\t\nSecurity group name\t\nKey name\t
Launch time\t\nPlatform details\t\nManaged\t\nOperator
sock-shop-major-project\ni-0d699c5549e9386dc\nRunning\n\nt3.micro\n3/3 checks passed\nap-south-1b
ec2-15-252-139-149.ap-south-1.compute.amazonaws.com\n15.252.139.149\n–\n–\ndisabled\nsock-shop-sg\nsock-shop-key
2026/10/08 23:35 GMT-7\nLinux/UNIX\nfalse\n–
open telemetry\ni-0538ab0304df3e83d\nRunning\n\nc7i-flex.large\n3/3 checks passed\nap-south-1b
ec2-13-233-155-34.ap-south-1.compute.amazonaws.com\n13.233.155.34\n–\n–\ndisabled\nlaunch-wizard-4\nsock-shop-key
2026/10/08 23:35 GMT-7\nLinux/UNIX\nfalse\n–
"""


def test_parse_console_paste():
    got = ec2import.parse(PASTE)
    assert [(g["name"], g["ip"], g["key_name"], g["state"]) for g in got] == [
        ("sock-shop-major-project", "15.252.139.149", "sock-shop-key", "running"),
        ("open telemetry", "13.233.155.34", "sock-shop-key", "running"),
    ]


def test_apply_updates_stale_ip_and_creates_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "DIR", tmp_path)
    c = config.load(projects.TEMPLATE)
    c["system"]["name"] = "open-telemetry"
    c["sources"]["jaeger"]["url"] = "http://13.201.89.80:8080/jaeger/ui"
    projects.save(c)

    r = ec2import.apply(PASTE, key_dir="/keys")
    by = {row["project"]: row for row in r["instances"]}
    assert by["open-telemetry"]["action"] == "updated"
    assert by["sock-shop-major-project"]["action"] == "created"

    ot = yaml.safe_load((tmp_path / "open-telemetry.yaml").read_text())
    assert ot["sources"]["jaeger"]["url"] == "http://13.233.155.34:8080/jaeger/ui"
    assert ot["ssh"]["host"] == "13.233.155.34" and ot["ssh"]["key_path"] == "/keys/sock-shop-key.pem"
    assert ot["source"]["mode"] == "tools"                      # existing mode is kept
    ss = yaml.safe_load((tmp_path / "sock-shop-major-project.yaml").read_text())
    assert ss["source"]["mode"] == "ssh" and ss["ssh"]["host"] == "15.252.139.149"

    again = ec2import.apply(PASTE, key_dir="/keys")              # re-pasting the same table changes nothing
    assert all(not row["changes"] for row in again["instances"])


def test_empty_paste_is_an_error():
    assert "error" in ec2import.apply("hello")

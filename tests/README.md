# tests

Cross-service checks that do not belong to one service: the restart test (data survives deleting the postgres pod), the scale test (requests keep succeeding while the api Deployment scales), and the end-to-end smoke run against a deployed stack. Unit and route tests live next to their service (`api/tests/`).

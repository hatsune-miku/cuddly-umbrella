# Artifact single-slot deployment 20260825-170803

Base image IDs:

- runner-agent: `sha256:7aee68633ebaff9a6b33b23db2abbd4c547e457db9e3d792daf9e45f19d7fcbc`
- build-worker: `sha256:84ebe9569c2441bf131395271fd49b05620768ac35a355baf1ffd7ba95773d1c`
- control-api: `sha256:dd1b9e2a6a31740f1ddb0657ed952e5e039366a1f2ad04cb1bbfb70965bbb694`
- gateway: `sha256:b063a40d110df3b9ad9429e7c1ba08d10c481a7cc0d053fcf3a76b540c582d2c`

Bundle SHA-256:

- runner-agent: `2B2722F3AC2F4A0EE2C8CE0E624AABCAC08FB73EEC9FE4F31484A3302F0FCD04`
- build-worker: `B7A909CBA1CAFE51959324563111853B2C390A38863CAB72773E133CCEDAAD45`
- control-api: `F0C5324F7F7C4E5A6531DA8BE86211DF14D4E6FB5CDBE7FCE76A0E74BEC24202`
- gateway: `F91FF78372456EF6739E4E05153D2EF8C96D60D00FB7F0D91349B3FF062352A8`

Rollback tags use `pre-artifact-single-slot-20260825-170803`. Because the deployment physically
deletes superseded Artifact directories, a complete data rollback must restore the matching PostgreSQL
dump and Artifact hard-link snapshot together after stopping the worker.

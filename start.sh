#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
cd "$(dirname "$0")"
echo "Starting Folderpost ..."
echo "Open http://localhost:${PORT:-3000} (or http://<this-computer>:${PORT:-3000} from another device)"
exec node server.js

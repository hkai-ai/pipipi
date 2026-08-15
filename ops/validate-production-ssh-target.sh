#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
    exit 64
fi

host="$1"
user="$2"
app_root="$3"
wrapped="/${app_root#/}/"

if [ "${#host}" -gt 253 ] ||
    ! [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    [[ "$host" == *..* ]] ||
    [ "$user" != root ] ||
    ! [[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    [ "$app_root" = / ] ||
    [[ "$app_root" == *//* ]] ||
    [[ "$wrapped" == */./* ]] ||
    [[ "$wrapped" == */../* ]] ||
    [[ "$app_root" == */ ]]; then
    exit 64
fi

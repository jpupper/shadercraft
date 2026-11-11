#!/bin/bash

# --- CONFIGURACION DEL PROYECTO ---
APP_NAME="shadercraft"
APP_DIR="/root/$APP_NAME"
BRANCH="main"

mkdir -p "$APP_DIR"

# Cargar variables de entorno si existen
if [ -f "$APP_DIR/.env" ]; then
    set -a
    source "$APP_DIR/.env"
    set +a
fi

GITHUB_REPO="jpupper/shadercraft"

if [ -n "$GITHUB_TOKEN" ]; then
    REPO_URL="https://$GITHUB_TOKEN@github.com/$GITHUB_REPO.git"
else
    REPO_URL="https://github.com/$GITHUB_REPO.git"
fi

echo "------------------------------------------------"
echo "DEPLOY: $APP_NAME (Repo: $GITHUB_REPO)"
echo "------------------------------------------------"

cd "$APP_DIR" || exit 1

if [ ! -d "$APP_DIR/.git" ]; then
    echo "Clonando repositorio por primera vez..."
    git init
    git branch -M $BRANCH
    git remote add origin "$REPO_URL" || git remote set-url origin "$REPO_URL"
    git fetch origin $BRANCH || git fetch https://github.com/$GITHUB_REPO.git $BRANCH
    git checkout -f FETCH_HEAD || git checkout -b $BRANCH origin/$BRANCH
else
    echo "Actualizando codigo existente..."
    git remote set-url origin "https://github.com/$GITHUB_REPO.git"
    git fetch origin $BRANCH
    git reset --hard origin/$BRANCH
fi

echo "Instalando dependencias..."
npm install --production

echo "Reestableciendo instancia de PM2..."
pm2 delete $APP_NAME 2>/dev/null || true
PORT=3255 pm2 start server.js --name "$APP_NAME"
pm2 save

echo "------------------------------------------------"
echo "DEPLOY FINALIZADO CON EXITO"
echo "------------------------------------------------"
pm2 status $APP_NAME

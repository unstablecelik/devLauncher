pkgname=devlauncher-git
pkgver=1.0.0
pkgrel=1
pkgdesc="A minimal open-source Minecraft launcher built with Electron"
arch=('x86_64')
url="https://github.com/fedevoral/devLauncher"
license=('MIT')
depends=('nodejs' 'java-runtime=21')
makedepends=('git' 'npm')
source=("git+https://github.com/fedevoral/devLauncher.git")
sha256sums=('SKIP')

build() {
  cd "$srcdir/devLauncher"
  npm install
  npm run build --if-present
}

package() {
  cd "$srcdir/devLauncher"
  install -d "$pkgdir/opt/devlauncher"
  cp -r . "$pkgdir/opt/devlauncher"

  install -d "$pkgdir/usr/bin"
  ln -s /opt/devlauncher/node_modules/.bin/electron "$pkgdir/usr/bin/devlauncher"
}

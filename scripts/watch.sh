#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
echo $DIR
cd $DIR
echo "Watching changes to design..."
while chronic inotifywait ../ -r -e modify -e create --exclude '.*.swp'; do 
  echo building...
  cd ..;
  chronic pipenv run blog build --debug;
  cd scripts;
done

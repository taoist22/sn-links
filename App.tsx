import React from 'react';
import LinksPanel from './src/LinksPanel';
import {installPluginRouter} from './src/pluginRouter';

installPluginRouter();

export default function App(): React.JSX.Element {
  return <LinksPanel />;
}

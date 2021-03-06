// @flow
import React from 'react';
// $FlowFixMe
import memoize from 'memoize-one';
import transformTrace from './calculateTraceLayout';
import type {RenderableMeasure} from './calculateTraceLayout';
import type {Measure, Layout, RenderableTrace} from './renderUtils';
import {UtilsWithCache} from './renderUtils';
import Controls from './Controls';
import DOMRenderer from './DOMRenderer';
import CanvasRenderer from './CanvasRenderer';
import type {HandleStateChangeFn} from './State';
import type {Element as ReactElement} from 'react';
import Minimap from './Minimap';

import {
  PX_PER_MS,
  BAR_HEIGHT,
  BAR_Y_GUTTER,
  BAR_X_GUTTER,
  MIN_ZOOM,
  MAX_ZOOM,
  TOOLTIP_OFFSET,
  TOOLTIP_HEIGHT,
} from './constants';

const SHOW_CONTROLS = false;
const USE_PERSISTENT_STATE = false;

type Props = {
  groupOrder?: Array<string>,
  persistView: boolean,
  truncateLabels: boolean,
  trace: Array<Measure>,
  renderer: 'canvas' | 'dom' | 'webgl',
  renderTooltip?: Measure => ReactElement<any>,
  viewportWidth: number,
  viewportHeight: number,
};

type State = {
  center: number,
  verticalOffset: number,
  defaultCenter: number,
  dragging: boolean,
  dragMoved: boolean,
  hovered: ?RenderableMeasure<Measure>,
  selection: ?RenderableMeasure<Measure>,
  zoom: number,
  defaultZoom: number,
  zooming: boolean,
};

// const run = fn => requestAnimationFrame(fn);
const run = fn => fn();

export default class Trace extends React.Component<Props, State> {
  _mouseX = 0;
  _mouseY = 0;

  constructor(props: Props) {
    super(props);
    const {startOffset, size} = this._getExtents();
    const defaultZoom = 1;
    const defaultCenter =
      startOffset + this.props.viewportWidth / PX_PER_MS / 2;
    const zoom = this.loadValue('zoom', defaultZoom);
    this.state = {
      dragging: false,
      dragMoved: false,
      selection: null,
      hovered: null,
      center: this.loadValue('center', defaultCenter),
      verticalOffset: 0,
      defaultCenter,
      zoom,
      defaultZoom,
      zooming: false,
    };
  }

  loadValue(name: string, defaultVal: number) {
    const item = localStorage.getItem(name);
    if ((this.props.persistView || USE_PERSISTENT_STATE) && item != null) {
      const parsed = parseFloat(item);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return defaultVal;
  }

  storeValue(name: string, val: number) {
    if (this.props.persistView || USE_PERSISTENT_STATE) {
      localStorage.setItem(name, String(val));
    }
  }

  componentDidMount() {
    document.addEventListener('keypress', this._handleKey);
    window.onbeforeunload = () => {
      this.storeValue('center', this.state.center);
      this.storeValue('zoom', this.state.zoom);
    };
  }

  _transformTrace = memoize(trace => transformTrace(trace));

  _transformTraceGroups = memoize(trace => {
    const groupedTraces = trace.reduce((groupsTraces, item) => {
      const group = item.group;
      const groupTrace = groupsTraces.get(group) || [];
      groupTrace.push(item);
      groupsTraces.set(group, groupTrace);
      return groupsTraces;
    }, new Map());
    const groupedRenderableTraces = new Map();
    for (let [group, trace] of groupedTraces) {
      groupedRenderableTraces.set(group, transformTrace(trace));
    }
    return groupedRenderableTraces;
  });

  _handleSelectionChange = (selection: ?RenderableMeasure<Measure>) => {
    this.setState({selection});
  };

  _clampCenter(updated: number) {
    const {startOffset, endOffset} = this._getExtents();
    return Math.max(startOffset, Math.min(endOffset, updated));
  }

  _getMinZoom() {
    const {size} = this._getExtents();
    return this.props.viewportWidth / size;
  }

  _clampZoom(updated: number) {
    return Math.max(this._getMinZoom(), Math.min(MAX_ZOOM, updated));
  }

  _handleKey = (event: KeyboardEvent) => {
    const {size} = this._getExtents();
    switch (event.key) {
      case 'w': {
        const updated = this.state.zoom * 2;
        run(() => {
          this.setState({zoom: this._clampZoom(updated)});
        });
        break;
      }
      case 'a': {
        const updated = this.state.center - (0.05 * size) / this.state.zoom;
        run(() => {
          this.setState({center: this._clampCenter(updated)});
        });
        break;
      }
      case 's': {
        const updated = this.state.zoom / 2;
        run(() => {
          this.setState({zoom: this._clampZoom(updated)});
        });
        break;
      }
      case 'd': {
        const updated = this.state.center + (0.05 * size) / this.state.zoom;
        run(() => {
          this.setState({center: this._clampCenter(updated)});
        });
        break;
      }
    }
  };

  _getExtents() {
    const renderableTrace = this._transformTrace(this.props.trace);

    const renderableTraceGroups = this._transformTraceGroups(this.props.trace);

    const startOffset = renderableTrace[0].measure.startTime;
    const last = renderableTrace[renderableTrace.length - 1];
    const endOffset = last.measure.startTime + last.measure.duration;

    return {
      startOffset,
      endOffset,
      size: endOffset - startOffset,
    };
  }

  _tooltip: ?Node = null;

  _onTooltip = (node: ?Node) => {
    this._tooltip = node;
  };

  _renderTooltip() {
    const tooltipX = this._mouseX + TOOLTIP_OFFSET;
    const tooltipY = this._mouseY + TOOLTIP_OFFSET;
    return (
      <div
        ref={this._onTooltip}
        style={{
          userSelect: 'none',
          position: 'absolute',
          left: tooltipX,
          top: tooltipY,
          backgroundColor: 'white',
          fontSize: 10,
          fontFamily: ' Lucida Grande',
          padding: '2px 4px',
          boxShadow: '3px 3px 5px rgba(0,0,0,0.4)',
        }}
      >
        {this.state.hovered ? this.state.hovered.measure.name : ''}
      </div>
    );
  }

  _handleStateChange: HandleStateChangeFn = changes => {
    this.setState(prevState => {
      return {
        ...changes,
        zoom:
          changes.zoom != null ? this._clampZoom(changes.zoom) : prevState.zoom,
        center:
          changes.center != null
            ? this._clampCenter(changes.center)
            : prevState.center,
      };
    });
  };

  render() {
    const renderableTrace = this._transformTrace(this.props.trace);

    const renderableTraceGroups = this._transformTraceGroups(this.props.trace);
    if (renderableTrace[0] == null) {
      return <div>empty trace</div>;
    }

    const extents = this._getExtents();
    const {startOffset, endOffset} = extents;

    const centerOffset = this.state.center;
    const renderer = this.props.renderer;
    const rendered = (
      <div>
        {(SHOW_CONTROLS || this.props.renderer === 'dom') && (
          <Controls
            zoom={this.state.zoom}
            center={this.state.center}
            extents={this._getExtents()}
            onChange={this._handleStateChange}
          />
        )}
        <Minimap
          renderableTrace={renderableTrace}
          renderableTraceGroups={renderableTraceGroups}
          groupOrder={this.props.groupOrder}
          {...this.state}
          extents={this._getExtents()}
          minZoom={this._getMinZoom()}
          viewportWidth={this.props.viewportWidth}
          viewportHeight={this.props.viewportHeight}
          tooltip={this._tooltip}
          renderTooltip={this.props.renderTooltip}
          truncateLabels={this.props.truncateLabels}
          renderer={renderer}
          onStateChange={this._handleStateChange}
          onSelectionChange={this._handleSelectionChange}
        />
        <div
          style={{
            cursor: this.state.dragging ? 'grabbing' : 'grab',
            position: 'relative',
          }}
        >
          {renderer === 'canvas' || renderer === 'webgl' ? (
            <CanvasRenderer
              renderableTrace={renderableTrace}
              renderableTraceGroups={renderableTraceGroups}
              groupOrder={this.props.groupOrder}
              {...this.state}
              extents={this._getExtents()}
              minZoom={this._getMinZoom()}
              viewportWidth={this.props.viewportWidth}
              viewportHeight={this.props.viewportHeight}
              tooltip={this._tooltip}
              renderTooltip={this.props.renderTooltip}
              truncateLabels={this.props.truncateLabels}
              renderer={renderer}
              onStateChange={this._handleStateChange}
              onSelectionChange={this._handleSelectionChange}
            />
          ) : (
            <DOMRenderer
              renderableTrace={renderableTrace}
              zoom={this.state.zoom}
              center={this.state.center}
              extents={this._getExtents()}
              viewportWidth={this.props.viewportWidth}
              viewportHeight={this.props.viewportHeight}
              onSelectionChange={this._handleSelectionChange}
            />
          )}
          {this._renderTooltip()}
        </div>
        <pre
          style={{
            borderTop: 'solid 1px #ccc',
            minHeight: 100,
            margin: 0,
          }}
        >
          {this.state.selection
            ? JSON.stringify(this.state.selection.measure, null, 2)
            : null}
        </pre>
      </div>
    );

    return rendered;
  }
}

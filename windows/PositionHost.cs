using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class PositionHost
{
    private const uint NoZOrder = 0x0004;
    private const uint NoActivate = 0x0010;
    // The standard window-position message caps the size to the monitor height.
    private const uint NoSendChanging = 0x0400;
    private const uint GetClientAreaAnimation = 0x1042;
    private const int SlideDurationMs = 240;
    private const int FrameIntervalMs = 16;
    private const int PollIntervalMs = 50;
    private const int HideDelayMs = 2500;
    private const uint RootWindow = 2;
    private const uint RootOwner = 3;

    private IntPtr watchedWindow;
    private int watchedProcess;
    private Rect expectedBounds;
    private int screenTop, edgeHeight, toolbarBottom;
    private string mode;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private long? leftToolbarAt;
    private long nextEventAt;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Bounds, WorkArea;
        public uint Flags;
    }

    public sealed class Request
    {
        public int left { get; set; }
        public int top { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public int offset { get; set; }
        public string mode { get; set; }
        public int toolbarHeight { get; set; }
        public bool place { get; set; }
        public int leftOffset { get; set; }
        public int widthOffset { get; set; }
        public int bottomOffset { get; set; }
    }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect bounds);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y,
        int width, int height, uint flags);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool SystemParametersInfoW(uint action, uint parameter,
        [MarshalAs(UnmanagedType.Bool)] out bool value, uint flags);

    private static void PositionAt(IntPtr window, Rect original, int top)
    {
        // Recalculate height at each step so the original bottom stays fixed.
        if (!SetWindowPos(window, IntPtr.Zero, original.Left, top, original.Width,
            original.Bottom - top, NoZOrder | NoActivate | NoSendChanging))
            throw new InvalidOperationException("Windows could not move the Chrome toolbar.");
    }

    private static void AnimateSlide(IntPtr window, Rect original, int targetTop)
    {
        if (targetTop == original.Top) return;
        bool animationsEnabled;
        if (SystemParametersInfoW(GetClientAreaAnimation, 0, out animationsEnabled, 0)
            && animationsEnabled)
        {
            var clock = Stopwatch.StartNew();
            int lastTop = original.Top;
            double elapsed = clock.Elapsed.TotalMilliseconds;
            while (elapsed < SlideDurationMs)
            {
                double progress = elapsed / SlideDurationMs;
                double eased = progress * progress * (3 - 2 * progress);
                int top = original.Top + (int)Math.Round((targetTop - original.Top) * eased);
                if (top != lastTop)
                {
                    CheckSlideBounds(window, original, lastTop);
                    PositionAt(window, original, top);
                    lastTop = top;
                }
                double frameEnd = Math.Min(elapsed + FrameIntervalMs, SlideDurationMs);
                double wait = frameEnd - clock.Elapsed.TotalMilliseconds;
                if (wait > 0) Thread.Sleep((int)Math.Ceiling(wait));
                elapsed = clock.Elapsed.TotalMilliseconds;
            }
            CheckSlideBounds(window, original, lastTop);
        }
        PositionAt(window, original, targetTop);
    }

    private static void CheckSlideBounds(IntPtr window, Rect original, int previousTop)
    {
        original.Top = previousTop;
        Rect current;
        if (!GetWindowRect(window, out current) || !current.Equals(original))
            throw new InvalidOperationException("Chrome changed its window bounds during the toolbar slide.");
    }

    private object Slide(Request request)
    {
        if (request == null || request.width <= 0 || request.height <= 0
            || (!request.place && (request.offset < -300 || request.offset > 300))
            || (request.mode != null && request.mode != "hidden"
                && request.mode != "revealed" && request.mode != "off")
            || request.toolbarHeight < 0 || request.toolbarHeight > 200)
            throw new InvalidOperationException("Invalid toolbar position request.");

        // Bind to the foreground Chrome window once, when the user enables the mode.
        // All later requests on this connection address the same window.
        bool binding = watchedWindow == IntPtr.Zero;
        IntPtr window = binding ? GetForegroundWindow() : watchedWindow;
        int processId;
        var className = new StringBuilder(64);
        if (window == IntPtr.Zero
            || GetWindowThreadProcessId(window, out processId) == 0
            || (!binding && processId != watchedProcess)
            || IsIconic(window)
            || GetClassName(window, className, className.Capacity) == 0
            || className.ToString() != "Chrome_WidgetWin_1")
            throw new InvalidOperationException("Focus the Chrome window and try again.");

        using (Process process = Process.GetProcessById(processId))
        {
            if (!String.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Focus the Chrome window and try again.");
        }

        Rect bounds;
        var monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        double scale = GetDpiForWindow(window) / 96.0;
        if (scale <= 0 || !GetWindowRect(window, out bounds)
            || !GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)
            || Math.Abs(bounds.Width - request.width * scale) > 2 * scale
            || Math.Abs(bounds.Height - request.height * scale) > 2 * scale
            || Math.Abs(bounds.Left - monitor.WorkArea.Left - request.left * scale) > 2 * scale
            || Math.Abs(bounds.Top - monitor.WorkArea.Top - request.top * scale) > 2 * scale
            || (binding && GetForegroundWindow() != window))
            throw new InvalidOperationException("The active Chrome window changed before the toolbar moved.");

        int y = bounds.Top + (int)Math.Round(request.offset * scale);
        Rect target = bounds;
        target.Top = y;
        if (request.place)
        {
            target.Left += (int)Math.Round(request.leftOffset * scale);
            target.Right = target.Left + bounds.Width + (int)Math.Round(request.widthOffset * scale);
            target.Bottom += (int)Math.Round(request.bottomOffset * scale);
            int margin = (int)Math.Ceiling(300 * scale);
            if (target.Width <= 0 || target.Left < monitor.Bounds.Left - margin
                || target.Right > monitor.Bounds.Right + margin || target.Right <= monitor.Bounds.Left
                || target.Left >= monitor.Bounds.Right || target.Top < monitor.Bounds.Top - margin
                || target.Bottom > monitor.Bounds.Bottom + margin || target.Bottom <= monitor.Bounds.Top
                || target.Top >= monitor.Bounds.Bottom)
                throw new InvalidOperationException("Invalid Chrome window bounds.");
        }
        if (target.Height <= 0)
            throw new InvalidOperationException("Invalid toolbar position request.");

        if (request.place) PositionAt(window, target, target.Top);
        else AnimateSlide(window, bounds, y);
        if (request.mode != null)
        {
            watchedWindow = window;
            watchedProcess = processId;
            mode = request.mode;
            screenTop = monitor.Bounds.Top;
            edgeHeight = (int)Math.Ceiling(8 * scale);
            if (!GetWindowRect(window, out expectedBounds))
                throw new InvalidOperationException("Chrome closed while the toolbar was moving.");
            toolbarBottom = expectedBounds.Top + (int)Math.Ceiling(request.toolbarHeight * scale);
            leftToolbarAt = null;
            nextEventAt = 0;
        }
        return new { ok = true, watching = request.mode != null };
    }

    private string PollHover()
    {
        Rect current;
        Point pointer;
        if ((mode != "hidden" && mode != "revealed")
            || IsIconic(watchedWindow) || !GetWindowRect(watchedWindow, out current)
            || !current.Equals(expectedBounds) || !GetCursorPos(out pointer))
            return null;

        IntPtr hit = WindowFromPoint(pointer);
        IntPtr root = GetAncestor(hit, RootWindow);
        long now = clock.ElapsedMilliseconds;
        string nextMode = null;
        if (mode == "hidden")
        {
            if (root == watchedWindow && pointer.Y >= screenTop && pointer.Y <= screenTop + edgeHeight
                && GetAsyncKeyState(1) >= 0 && GetAsyncKeyState(2) >= 0)
                nextMode = "revealed";
        }
        else if (root == watchedWindow ? pointer.Y < toolbarBottom
            : GetAncestor(hit, RootOwner) == watchedWindow)
        {
            // Include menus owned by the toolbar, even below its bottom edge.
            leftToolbarAt = null;
        }
        else
        {
            if (!leftToolbarAt.HasValue) leftToolbarAt = now;
            if (now - leftToolbarAt.Value >= HideDelayMs) nextMode = "hidden";
        }

        if (nextMode == null || now < nextEventAt) return null;
        nextEventAt = now + 500;
        return nextMode;
    }

    private static string ReadMessage(BinaryReader input)
    {
        try
        {
            int length = input.ReadInt32();
            if (length < 1 || length > 1024) return null;
            byte[] message = input.ReadBytes(length);
            return message.Length == length ? Encoding.UTF8.GetString(message) : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static void WriteMessage(BinaryWriter output, JavaScriptSerializer json, object message)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(message));
        output.Write(bytes.Length);
        output.Write(bytes);
        output.Flush();
    }

    private void Run(BinaryReader input, BinaryWriter output)
    {
        var json = new JavaScriptSerializer();
        while (true)
        {
            // Read on a separate thread so pointer polling continues without messages from Chrome.
            var reading = Task.Factory.StartNew(() => ReadMessage(input));
            while (!reading.Wait(PollIntervalMs))
            {
                string nextMode = PollHover();
                if (nextMode != null) WriteMessage(output, json, new { hoverMode = nextMode });
            }
            string message = reading.Result;
            if (message == null) return;
            Request request = null;
            object result;
            try
            {
                request = json.Deserialize<Request>(message);
                result = Slide(request);
            }
            catch (Exception error)
            {
                result = new { ok = false, error = error.Message };
            }
            WriteMessage(output, json, result);
            if (request == null || request.mode == null || watchedWindow == IntPtr.Zero) return;
        }
    }

    private static void Main()
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        try
        {
            using (var input = new BinaryReader(Console.OpenStandardInput()))
            using (var output = new BinaryWriter(Console.OpenStandardOutput()))
                new PositionHost().Run(input, output);
        }
        catch (IOException)
        {
            // Chrome closed the connection.
        }
    }
}

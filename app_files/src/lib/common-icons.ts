/**
 * Commonly used Lucide React icons - pre-exported for convenience
 * This helps prevent missing import errors for frequently used icons
 * 
 * Usage:
 * import { Menu, X, Check, Shield } from '@/lib/common-icons'
 * 
 * Or import all:
 * import * as Icons from '@/lib/common-icons'
 */

// Re-export all commonly used icons
export {
  // Navigation & UI
  Menu, X, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
  
  // Actions
  Check, Plus, Minus, Edit, Trash, Save, Download, Upload, Share, Copy,
  
  // Status & Info
  Info, AlertCircle, CheckCircle, XCircle, HelpCircle,
  
  // Common Objects
  User, Users, Home, Settings, Search, Filter, Calendar, Clock,
  Mail, Phone, MapPin, Globe,
  
  // Business & Features
  Shield, Lock, Unlock, Key, CreditCard, DollarSign,
  ShoppingCart, Package, Gift,
  
  // Media
  Image, Camera, Video, Mic, Volume, VolumeX, Play, Pause,
  
  // Tech & Development
  Code, Terminal, Cpu, Database, Cloud, Wifi,
  
  // Social
  Github, Twitter, Linkedin, Facebook,
  
  // Premium/Marketing
  Zap, Crown, Star, Heart, ThumbsUp, TrendingUp,
  Rocket, Target, Award, Trophy,
  
  // Loading & Progress
  Loader, Loader2, RefreshCw
} from 'lucide-react'

// Re-export all icons for cases where specific ones are needed
export * from 'lucide-react'